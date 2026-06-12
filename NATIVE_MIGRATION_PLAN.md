# Vizzy Native Engine Migration Plan

> **Status (2026-06-12):** Phase 0/1 implemented — Tauri 2 shell (`src-tauri/`),
> native audio (cpal + rustfft), native MIDI (midir), Ollama runtime manager in
> Rust, `src/platform/` host abstraction, CI (`ci.yml`) + Tauri build/release
> (`build.yml`). The Electron path is deleted (no backward compatibility of any
> kind — no legacy shell, data, or localStorage keys). Known gaps until Phase 2:
> master output window, and rendering still runs via Three.js in the webview
> (as planned).

Migrate Vizzy from Electron + Three.js to a **hybrid architecture**: the React UI stays
web-based, while rendering, audio analysis, MIDI, and OS integration move into a native
Rust core. Goal: native frame pacing, lower audio latency, Syphon/Spout/NDI output to
other VJ software, and a dramatically smaller footprint — without rewriting the UI or
the LLM orchestration.

**Clean-slate scope:** no backward compatibility with existing user shaders, libraries,
or session state. Prompts are free to target a new shader dialect, schemas can be
redesigned, and no data migration ships. This unlocks the modern GPU stack (wgpu)
instead of legacy OpenGL.

---

## 1. Target architecture

```
┌──────────────────────────── Tauri app (single binary) ────────────────────────────┐
│                                                                                   │
│  ┌── Webview (system) ──────────────┐      ┌── Rust core ───────────────────────┐ │
│  │ React UI (unchanged components)  │      │ Render engine (wgpu →              │ │
│  │ Mixer, DeckModule, Knob, TopBar  │ cmds │   Metal / Vulkan / DX12)           │ │
│  │ Library panel, Tutorial, Setup   │─────▶│  - 8 deck targets, A/B/master      │ │
│  │ LLM generation queue + recipes   │      │  - naga shader ingest + validate   │ │
│  │ Session/library orchestration    │◀─────│  - automation / loop evaluation    │ │
│  └──────────────────────────────────┘ evts │ AudioEngine (cpal + rustfft)       │ │
│                                            │ MidiEngine (midir, learn mode)     │ │
│            Ollama (external HTTP,          │ Master output window (winit/tao)   │ │
│            ports 11434/11435) ◀────────────│ Syphon (macOS) / Spout (Windows)   │ │
│                                            │ File storage (session, library)    │ │
│                                            │ Ollama runtime manager             │ │
│                                            └────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Key decisions (and why)

| Decision | Choice | Rationale |
|---|---|---|
| App shell | **Tauri 2** (replaces Electron) | Rust core and shell are one process — engine state is in-process, no socket IPC. ~10× smaller binary, faster startup. Typed commands/events. |
| Graphics API | **wgpu** (Metal on macOS, Vulkan on Linux, DX12 on Windows) | Modern, actively developed, no macOS deprecation cloud. First-class runtime shader compilation via naga. Clean slate removes the only argument for OpenGL. |
| LLM shader dialect | **GLSL bodies ingested via naga's GLSL frontend** (start), WGSL prompts as an A/B experiment | qwen2.5-coder's training data has vastly more GLSL than WGSL, so generation quality is higher in GLSL. naga compiles GLSL fragments straight into wgpu pipelines, so prompts barely change. The repair loop's compile-success rate is the metric for switching to native WGSL prompts later. |
| Shader validation | **In-process naga parse/validate** | Replaces the WebGL `glValidate.ts` pre-check entirely — synchronous, in the same process as the pipeline, richer errors for the repair loop. One validation path instead of two. |
| LLM orchestration | **Stays in TypeScript** | `GenerationQueue`, recipes, parser, scene-spec parsing are pure TS with no perf cost. Native engine returns naga errors over IPC, feeding the existing repair loop unchanged. |
| Procedural geometry | **Stays in TypeScript** | `sceneGenerator.ts` + the `expr.ts` sandbox are pure math. Generated terrain/tunnel meshes ship to the core as typed arrays for GPU upload — no Rust port of the expression sandbox needed. |
| Audio + MIDI | **Move native (early)** | Required, not optional: Tauri's WKWebView (macOS) and webkit2gtk (Linux) do not support WebMIDI, and getUserMedia is unreliable. `cpal` + `rustfft` and `midir` also beat Web Audio/WebMIDI on latency, which was a goal anyway. |
| UI previews | **Event-streamed frames** | Deck previews already run round-robin at ~15 fps low-res. Core downsamples and pushes JPEG frames over Tauri events; UI draws to the existing preview canvases. A/B scene monitors use the same mechanism. |
| Data formats | **Free to redesign; keep current shapes where convenient** | No migration ships. In practice the session/library/MIDI-binding JSON shapes are fine and the TS code already speaks them — keep them unless the native split motivates a change. |

**Fallback considered:** keeping Electron and running the Rust engine as a sidecar
child process. Lower churn, but it keeps the 300 MB Chromium shell, requires a
socket/stdio protocol instead of in-process commands, and still needs the same engine
work. Only fall back to this if Tauri webview issues prove blocking in Phase 1.

---

## 2. The web/native boundary (IPC contract)

Define once in Phase 0, generate types for both sides (`specta` + `tauri-specta`
producing TS bindings from Rust types — single source of truth).

**UI → Core (commands):**
- `set_param { slot, param, value }` — opacity, scale, sizeX/Y, posX/Y, tilt, contrast,
  hue, sat, brightness, lightAngle, layer, mute
- `set_crossfade`, `set_cue_scene`, `set_bpm`
- `set_loop { slot, lanes }` — full keyframe lanes `{t, v, bend}` (evaluated natively per frame)
- `set_aut { slot, effects }` — the 6 AUT effects `{amt, audio}` (scl/rot/tlt/flk/dst/skw)
- `set_audio_routing { slot, band, amount }`
- `stage_shader { slot, code }` → `Result<(), CompileError>` (naga errors drive the repair loop)
- `stage_sprite { slot, spriteId }`, `stage_model { slot, modelId }`,
  `stage_landscape { slot, source }`, `stage_scene { slot, spec, vertexData }`
- `audio_start { deviceId? }`, `audio_stop`, `audio_list_devices`
- `midi_learn { controlId }`, `midi_clear { controlId }`, `midi_set_bindings`
- `master_window { open | close | fullscreen, display? }`
- `texture_share { syphon | spout | off }`
- Storage: `load_session`, `save_session`, library CRUD, `get_*_dir` (replaces the four
  `vizzy:get-*-dir` Electron IPC handlers)
- Ollama runtime: `ollama_status`, `ollama_install`, `ollama_start` (replaces
  `ollama-manager.cjs`; install progress streamed as events)

**Core → UI (events):**
- `preview_frame { slot, jpegBytes }` (~10–15 fps), `monitor_frame { scene, jpegBytes }`
- `audio_levels { low, mid, high, level }` (~30 Hz, for UI meters only — the render loop
  reads levels in-process)
- `midi_event { cc, value }`, `midi_learned { controlId, cc }`
- `deck_state { slot, state, error? }` (queued/compiling/active/failed — same states the
  UI shows today)
- `ollama_progress`, `engine_stats { fps, frameTimeMs }`

---

## 3. Phased delivery (strangler pattern — app ships at every phase)

### Phase 0 — Contracts & prep (~1 week)
- Define all IPC types above in a Rust crate; wire `specta` TS generation.
- Extract pure-TS logic that both eras share into clean modules (already mostly true:
  `loopControls.ts`, `expr.ts`, `sceneGenerator.ts`, `llm/*`).
- Add characterization tests pinning current *behavioral* math: loop keyframe
  interpolation (including bend curves), audio band → bin mapping and 0.15 lerp
  smoothing, the compositing rules (tilt aspect correction, Rodrigues hue rotation,
  additive same-layer / over-blend cross-layer). These become the parity oracle for the
  Rust ports. (Pixel-exact parity with the old renderer is *not* a goal — clean slate —
  but the compositing behavior the UI knobs promise should survive.)
- Spike: run 20–30 representative prompts through qwen2.5-coder and compile the output
  with naga's GLSL frontend; measure pass rate vs the current WebGL pipeline. This
  validates the shader-dialect decision before Phase 2 commits to it.

### Phase 1 — Tauri shell + native audio/MIDI/storage (~2 weeks)
The app moves to Tauri but **still renders via Three.js in the webview**.
- Scaffold Tauri 2; mount the existing Vite/React build. Keep `npm run dev` HMR via
  `tauri dev`.
- Port the remaining `electron/main.cjs` responsibilities: window config (1480×940
  main), the `get-*-dir` storage commands. No data migrations — fresh app-data dir,
  first-run example seed regenerates content.
- Port `ollama-manager.cjs` to Rust: download/extract per-platform binary to app-data,
  `ollama serve` on 11435, kill on quit, status/install/start commands with streamed
  progress. The Setup screen UI is unchanged.
- Native audio: `cpal` input capture (+ device enumeration), 512-bin `rustfft`, the four
  band averages (20–250 / 250–2000 / 2000–8000 / 20–16000 Hz) with identical 0.15 lerp.
  Levels streamed to the webview so the *temporary* Three.js render path keeps its
  audio reactivity.
- Native MIDI: `midir` input, learn mode (arm → first CC seen binds), bindings persisted
  as JSON. Events streamed to UI; UI keeps mapping CC → state changes exactly as
  `useMidiControls` does now.
- `session.json` save/load moves to Rust commands (debounced save + sync save on quit).
- **Exit criteria:** feature-parity Vizzy running under Tauri on all three OSes; audio
  reactivity and MIDI learn work on macOS/Linux (where they'd otherwise be broken in
  the webview); installer size drops by ~150–250 MB.

### Phase 2 — Native render core: shader decks + compositor + master window (~3–4 weeks)
The heart of the migration.
- wgpu device + surface on a `winit` output window; offscreen textures for the 8 deck
  targets (960×h, **mirror-repeat samplers** — this address mode is load-bearing for
  zoom-out tiling), scene A/B composites, master composite, 4 preview targets
  (round-robin).
- Rewrite the compositor in WGSL (app-owned, written by hand once): the scene composite
  (4 decks, additive same-layer, coverage-masked over-blend across layers), the master
  composite (A/B crossfade via `u_xfade`), and `deckColor()`-equivalent sampling
  (mix/scale/size window, aspect-corrected tilt, Rodrigues hue, contrast/sat, UV
  warp/shear), plus the preview shader. Verified against Phase 0 behavioral tests.
- LLM shader ingestion: app-owned GLSL header (declaring `u_time`, `u_resolution`,
  `u_audio_low/mid/high/level`) + generated body → naga GLSL frontend → wgpu pipeline.
  Update the system prompt and the 6 style recipes for the new header/entry-point
  conventions; rewrite the 8 default startup shaders and the example seed for the new
  pipeline. Keep a WGSL variant of the system prompt behind a flag to A/B compile
  success rates.
- Validation/repair: `stage_shader` runs naga parse → validate → pipeline creation;
  any error string returns to the UI and feeds the existing regenerate-with-error
  repair flow. Staging keeps current semantics: build off-thread, warm-up render, swap
  on success, `failed` + error on failure.
- Master output window: native `winit` window, fullscreen toggle, display picker
  (replaces the `window.open()` + Electron pop-out in `useMasterWindow.ts`).
- Preview/monitor frame streaming to the UI canvases.
- During this phase the webview Three.js path remains behind a runtime flag
  (`VIZZY_LEGACY_RENDER=1`) as an escape hatch.
- **Exit criteria:** shader decks (incl. new defaults), full mixer
  (opacity/mute/layers/crossfade/FX knobs), generation + repair loop, master window —
  all native; LLM compile-success rate within a few points of the old WebGL pipeline.

### Phase 3 — Remaining deck content types (~3–4 weeks)
- **Sprites:** decode PNG/JPG with the `image` crate; aspect-preserving centered quad;
  port the sprite shader pair to WGSL (mesh transform, sine UV wobble + shear,
  out-of-bounds transparent).
- **Models:** load .gltf/.glb (`gltf` crate) and .obj (`tobj`); port normalization
  (fit-to-unit + center), auto-rotate, and the 3-light vaporwave rig with a small
  forward-lit WGSL shader (key/fill/rim, brightness scales all three, lightAngle orbits
  the key light — `applyLightRig` semantics).
- **Landscapes:** model-as-terrain fly-over — two leapfrogging tiles, forward camera
  scroll with the always-on audio boost (`baseSpeed × (1 + level × 1.5)`), camHeight,
  span logic.
- **Procedural scenes:** `sceneGenerator.ts` and the `expr.ts` sandbox stay in TS;
  `stage_scene` ships the generated vertex/color/index buffers as binary payloads for
  native GPU upload. Scene-spec JSON parsing and the LLM scene prompt are untouched.
- **Exit criteria:** all 5 deck modes native; library entries of every type save/load;
  the first-run example seed works.

### Phase 4 — Automation, loops, and AUT effects native (~1–2 weeks)
Per-frame evaluation must live where the frame loop lives.
- Port `loopControls.ts` keyframe evaluation (t/v/bend bezier curves, block count ×
  beats-per-block, global BPM sync, fader-lane-multiplies-opacity + mute-wins rule).
- Port `automation.ts`: all 6 AUT effects with their per-deck-type application
  (shader → composite uniform modulation; model → scene-graph transforms;
  sprite → mesh + uniforms; landscape/scene → camera language), audio-coupled vs
  LFO self-run modes, `pinCompositeToBase` for non-shader decks.
- UI sends loop/AUT *configuration* only; the core evaluates every frame. The loop
  editor UI is unchanged.
- Verify against Phase 0 characterization tests (same input lanes → same evaluated
  values).
- **Exit criteria:** delete the legacy render flag; remove `three` from dependencies.

### Phase 5 — VJ ecosystem output (~2 weeks)  ← the headline payoff
- **macOS:** Syphon server publishing the master composite via **Syphon's Metal API**
  (wgpu-hal exposes the underlying `MTLTexture`; small Objective-C bridge crate).
- **Windows:** Spout sender via DX shared-texture interop — wgpu-hal exposes the DX12
  resource; share to Spout's DX11 receivers through a keyed-mutex shared handle. This
  is the fiddliest interop in the plan; prototype it early in the phase.
- **All platforms (optional):** NDI output behind a feature flag (CPU-frame based, so
  trivially compatible with wgpu readback; confirm SDK redistribution terms before
  bundling).
- UI toggle in TopBar; output is the master composite at full res/framerate.
- **Exit criteria:** Vizzy appears as a live source in Resolume/OBS at 60 fps.

### Phase 6 — Performance hardening & polish (~1 week)
- Frame pacing audit: present-mode tuning on the master window (Fifo vs Mailbox),
  decouple preview streaming from the render loop, `engine_stats` overlay.
- Audio latency pass: shrink cpal buffer, measure beat-to-photon.
- Memory/startup benchmarks vs the Electron build (publish numbers in the README).
- Crash safety: shader compile and deck staging must never take down the engine
  (panic isolation per staging operation; a live set must survive a bad shader).
  Note wgpu validation already prevents the GPU-fault class of crashes raw GL allows.

### Phase 7 — CI/CD & packaging (~1 week, overlaps earlier phases)
See §5. Runs in parallel from Phase 1 — CI builds the Tauri app from the first scaffold.

**Total: roughly 11–16 weeks solo.** Phases 2–3 are the risk concentration; everything
else is mechanical.

---

## 4. Feature coverage checklist

Every current feature, where it lands, and which phase ports it:

| Feature | Destination | Phase |
|---|---|---|
| 8 decks / 2 scenes / 4 layers, additive + over blending | Rust core (WGSL compositor) | 2 |
| Crossfade, opacity faders, mute, cue scene | UI state → core params | 2 |
| Channel FX (tilt/contrast/hue/sat) | Core composite shaders | 2 |
| Shader decks + 8 default startup shaders (rewritten) | Core | 2 |
| LLM generation queue, parser, repair loop | TS (unchanged) | 2 (wires to naga errors) |
| System prompt + 6 style recipes | TS, **updated for new dialect/header** | 2 |
| Scene generation (JSON spec, expr sandbox, terrain/tunnel) | TS geometry → core upload | 3 |
| Sprite decks | Core | 3 |
| 3D model decks + vaporwave light rig | Core | 3 |
| Landscape fly-over decks | Core | 3 |
| Audio capture, 4-band FFT, per-deck routing | Core (cpal/rustfft) | 1 |
| MIDI learn + bindings (master xfade, 8 strips) | Core (midir) + UI mapping | 1 |
| Beat-locked loop lanes (t/v/bend), global BPM | Core evaluation, UI editing | 4 |
| AUT effects (scl/rot/tlt/flk/dst/skw, audio-coupled) | Core | 4 |
| Master output window + fullscreen | Core (winit) | 2 |
| Deck previews + A/B monitors | Core render → event stream | 2 |
| Library (shaders/decks/models/sprites/scenes) | Rust file IO, fresh store | 1 |
| Session save/restore (`session.json`) | Rust file IO, fresh store | 1 |
| Managed Ollama runtime (port 11435, download, lifecycle) | Rust port | 1 |
| Setup screen, Tutorial, example seed (regenerated) | UI (unchanged) | 1 |
| Permission handling (mic) | OS-level (Info.plist / manifest) | 1 |
| **New:** Syphon/Spout/NDI output | Core | 5 |

Explicitly dropped (clean slate): legacy `prompt-vj` migration, Electron-userData
migration, GLSL shader-library compatibility.

---

## 5. Build & deploy chain (GitHub workflows)

Replaces the current single `build.yml` (Node-only, electron-builder, rolling `latest`
release). Preserves the rolling-latest model and unsigned-build posture.

### `ci.yml` — PRs and pushes (fast feedback)
- `npm ci` → `npm run typecheck` → `npm test` (vitest — UI, hooks, TS logic)
- `cargo fmt --check` → `cargo clippy -- -D warnings` → `cargo test` (engine behavioral
  tests from Phase 0, loop/automation/audio-band unit tests; render tests run headless
  on CI via `lavapipe`, Mesa's software Vulkan driver — wgpu picks it up with
  `WGPU_BACKEND=vulkan` on GPU-less runners)
- Runs on `ubuntu-latest` only (cheap); the build matrix below covers per-OS issues.

### `build.yml` — push to `main` + `workflow_dispatch` (artifacts + rolling release)

```yaml
name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest          # arm64
            target: aarch64-apple-darwin
            bundles: dmg
          - os: macos-13              # x86_64 (or build a universal binary on arm64)
            target: x86_64-apple-darwin
            bundles: dmg
          - os: ubuntu-22.04          # oldest glibc we ship
            target: x86_64-unknown-linux-gnu
            bundles: appimage,deb
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            bundles: nsis
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }

      - uses: dtolnay/rust-toolchain@stable
        with: { targets: "${{ matrix.target }}" }

      - uses: swatinem/rust-cache@v2
        with: { workspaces: src-tauri }

      - name: Linux system deps
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
            librsvg2-dev libasound2-dev libudev-dev patchelf
          # webkit2gtk: Tauri webview · alsa: cpal audio · udev: midir

      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: cargo test --manifest-path src-tauri/Cargo.toml

      - name: Build app
        uses: tauri-apps/tauri-action@v0
        with:
          args: --target ${{ matrix.target }} --bundles ${{ matrix.bundles }}
        # Unsigned builds, as today. When signing lands:
        # macOS: APPLE_CERTIFICATE / APPLE_SIGNING_IDENTITY + notarytool secrets
        # Windows: AZURE_TRUSTED_SIGNING or PFX secrets

      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.os }}-${{ matrix.target }}
          path: |
            src-tauri/target/${{ matrix.target }}/release/bundle/dmg/*.dmg
            src-tauri/target/${{ matrix.target }}/release/bundle/appimage/*.AppImage
            src-tauri/target/${{ matrix.target }}/release/bundle/deb/*.deb
            src-tauri/target/${{ matrix.target }}/release/bundle/nsis/*.exe
          if-no-files-found: error

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { path: builds, merge-multiple: true }
      - name: Update rolling "latest" release
        env: { GH_TOKEN: "${{ github.token }}" }
        run: |
          gh release delete latest --cleanup-tag --yes || true
          gh release create latest builds/* \
            --title "Latest build" \
            --notes "Automated build of ${{ github.sha }}. Unsigned binaries — macOS: \
          move Vizzy.app to Applications, then run: \
          xattr -dr com.apple.quarantine /Applications/Vizzy.app" \
            --latest
```

Notes:
- **Artifact naming** moves from `Vizzy-${os}.${ext}` (electron-builder) to Tauri's
  bundle names; set `productName`/version in `tauri.conf.json` to keep `Vizzy-*`
  filenames so the GitHub Pages download links keep working.
- **macOS x86_64**: either the second matrix row above, or drop it and produce a
  universal binary on the arm64 runner (`--target universal-apple-darwin`) — fewer CI
  minutes, bigger artifact. Recommend universal once Phase 2 lands.
- **Rust cache** is the big CI-time lever; cold Tauri builds are ~10–15 min, cached ~3.
- **Platform-conditional crates**: the Syphon bridge compiles only on macOS, Spout only
  on Windows (`[target.'cfg(...)'.dependencies]`) — no matrix changes needed.
- **Renovate/dependabot**: add `cargo` ecosystem alongside `npm`.
- The Tauri **updater** (signed update manifests) is deliberately out of scope while
  builds are unsigned; the rolling `latest` release remains the distribution channel.

### Repo layout after migration

```
vizzy/
├── src/                 # React UI + TS logic (llm/, lib/, components/, hooks/)
├── src-tauri/           # Rust core
│   ├── src/{render,audio,midi,storage,ollama,ipc}/
│   ├── shaders/         # hand-written WGSL (compositor, sprite, model, preview)
│   ├── crates/syphon-bridge/   (macOS only)
│   └── tauri.conf.json
├── bindings/            # specta-generated TS types (committed)
├── .github/workflows/   # ci.yml, build.yml
└── docs/                # GitHub Pages site (unchanged)
```

`electron/` is deleted at the end of Phase 1.

---

## 6. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| naga's GLSL frontend rejects constructs qwen2.5-coder likes to emit (coverage gaps vs a real GL compiler) | **High** | Phase 0 spike measures the pass rate on representative prompts *before* Phase 2 commits. Levers, in order: tighten the system prompt/recipes toward naga-friendly GLSL; switch prompts to native WGSL (A/B flag already planned); the repair loop is the standing safety net — failed compiles already have a recovery UX. |
| WGSL prompt quality if we switch dialects (less WGSL than GLSL in model training data) | Medium | Only taken if the A/B shows it wins; richer few-shot examples in the system prompt; repair loop with naga's (excellent) WGSL error messages. |
| Spout interop with wgpu/DX12 (keyed-mutex shared textures to DX11 receivers) | Medium | Prototype first thing in Phase 5; fallback is an NDI-only Windows story for v1 (Spout-over-NDI bridges exist in the ecosystem). |
| Compositing behavior drift in the WGSL rewrite (blending, color math) | Medium | Phase 0 characterization tests pin the math; the formulas (Rodrigues hue, layer stack rules) port symbol-for-symbol even though the language changes. Pixel-exactness is explicitly not required. |
| Tauri webview quirks (WKWebView/webkit2gtk CSS or API gaps vs Chromium) | Medium | The UI is canvas-light after migration (previews are streamed images); audit in Phase 1 on all three OSes before deleting Electron. Electron+sidecar is the documented fallback. |
| Three.js model rendering parity (lighting look) | Low-Medium | The rig is only 3 lights + standard materials; match by eye against reference captures, accept "close, not identical" — these are VJ visuals, not CAD. |
| cpal device handling edge cases (sample rates, hot-unplug) | Low-Medium | Device enumeration + graceful restart in Phase 1; the current Web Audio path has the same class of issues today. |
| NDI SDK licensing | Low | Optional feature flag; Syphon (BSD) and Spout (BSD) carry the headline feature. |

---

## 7. Testing strategy

- **TS (vitest, unchanged):** UI components, hooks, LLM parser/recipes/scene parsing,
  expression sandbox, scene generator, session/library logic. Engine-facing hooks get
  a mocked IPC layer.
- **Rust (cargo test):** loop evaluation, AUT math, audio band mapping/smoothing, MIDI
  learn state machine, session/library IO round-trips — all validated against the
  Phase 0 characterization fixtures (shared JSON fixtures consumed by both test
  suites).
- **Shader corpus tests:** the Phase 0 prompt spike becomes a fixture corpus — every CI
  run compiles the corpus through naga to catch ingestion regressions.
- **Render tests:** headless wgpu on lavapipe (software Vulkan) renders fixed
  shader/uniform scenarios; image-diff with tolerance against committed references.
- **Smoke test:** CI launches the built app, stages one shader per platform, asserts
  `engine_stats` reports frames within 5 s (Tauri WebDriver or a `--self-test` flag).

---

## 8. What explicitly does *not* change

- Every React component, the visual design, Tailwind setup.
- The LLM *flow*: Ollama HTTP contract, qwen2.5-coder default, sequential generation
  queue, repair-with-error-log loop, scene-spec JSON `{kind, surface, amplitude,
  palette}`. (Prompt *content* and the 6 recipes get updated for the new
  header/dialect; the machinery doesn't.)
- The expression sandbox and procedural geometry generation (pure TS).
- The GitHub Pages site in `docs/` and the rolling `latest` release distribution model.

## 9. Future path (post-migration, out of scope)

- **Native WGSL prompts as the primary dialect** once model quality catches up (the A/B
  flag from Phase 2 makes this a config change, not a project).
- **Tauri updater** once code signing is in place.
- Video file decks and live camera input (cheap natively via ffmpeg/AVFoundation —
  was impractical under Electron).
- Ableton Link tempo sync (`rusty_link`) — natural fit once BPM lives in the core.
