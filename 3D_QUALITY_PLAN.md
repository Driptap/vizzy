# 3D Quality & Shader Reliability Plan

Field testing of the native app (2026-06-12) confirmed the migration works end
to end — Syphon, MIDI, audio reactivity — and surfaced two regressions versus
the Electron build:

1. **Most LLM shader generations fail to compile.** The Phase 0 risk
   materialized: naga's GLSL frontend is stricter and far less battle-worn
   than the ANGLE compiler the WebGL path used, and it's the least-maintained
   frontend in the naga project. The TS parser already repairs the common
   dialect slips (Shadertoy entry points, custom out-vars), so the rejects
   are happening inside naga.
2. **3D content looks flatter and feels less fun.** Known, specific causes:
   no sRGB output conversion (three.js converted lighting to sRGB; we output
   linear values to an 8-bit target — everything reads dark/muddy), glTF
   textures are skipped (textured models render as flat base color), the
   lighting model is diffuse-only Lambert vs three.js's specular materials,
   no MSAA on mesh edges, and the in-app A/B monitors dropped from a 60 fps
   canvas blit to ~30 fps base64-JPEG events, which reads as "performance
   got worse" even though the master output runs at full rate.

Three workstreams, instrumentation first — the shader fixes must be driven by
the real failure corpus, not guesses.

---

## Workstream A — Shader generation reliability

**A1. Capture the failure corpus (first, cheap).**
Every compile failure already returns the error to the repair loop; also
persist `{prompt, generated code, sanitized source, error}` as JSON to
`<userData>/shader-failures/` and add a generation success-rate counter
(attempts vs. active) surfaced in the TopBar dev stats (C2). One session of
real use then tells us exactly which GLSL constructs naga chokes on.

**A2. Replace the compile path with driver-grade GLSL acceptance (structural fix).**
Compile generated GLSL with **glslang** (the Khronos reference compiler, via
the `glslang` crate or shaderc) to SPIR-V, then feed wgpu through naga's
**SPIR-V frontend** — which is mature and well-maintained, unlike glsl-in.
glslang accepts the same dialect breadth real drivers do, which is what the
LLM's training data was written against. Keep naga glsl-in as the zero-dep
fallback if glslang fails to build on a platform. Error messages from glslang
are also better repair-loop fuel (line numbers + GLSL-native vocabulary).
Acceptance test: the existing ingest corpus plus every shader in the captured
failure corpus from A1.

**A3. Tune the prompt and sanitizer from evidence.**
- Extend the Rust sanitizer for whatever A1 shows (likely candidates:
  mid-line precision qualifiers, ES-version pragmas, redeclared outputs).
- Update `SYSTEM_PROMPT` with the handful of constructs that still fail
  after A2, phrased as positive constraints ("declare loop indices as int",
  not naga jargon), plus one or two few-shot examples of known-good output.
- Keep feeding the compiler error verbatim into the Regenerate flow (already
  wired) — with glslang's friendlier errors this loop should converge better.

**A4. Definition of done:** generation success rate at or above the Electron
baseline, measured by the A1 counter over a real session. (If Ollama gets
installed on the dev machine, add the deferred Phase 0 spike as an automated
batch: N prompts → success rate, runnable before/after each change.)

## Workstream B — 3D visual parity and polish

**B1. sRGB-correct color pipeline (biggest single visual fix).**
Do lighting math in linear and convert to sRGB at the deck-target write for
mesh passes (or render mesh content to `Rgba8UnormSrgb` views), matching
three.js's `outputColorSpace = sRGB`. Decode glTF base-color textures and
factors as sRGB→linear on upload. Shader decks are unaffected (LLM shaders
write display-referred values, same as WebGL).

**B2. glTF base-color textures + mipmaps.**
The deferred `baseColorTexture` support: sample it in the mesh shader
(modulated by factor and vertex color), generate mipmaps at upload, sRGB
view. This is the difference between "textured model" and "grey blob" for
most downloaded glTFs. Stretch: normal maps if cheap.

**B3. Specular material upgrade.**
Replace diffuse-only Lambert with Blinn-Phong (or GGX if it stays simple)
driven by glTF metallic/roughness factors; OBJ/STL keep the neutral material
(roughness .45 / metalness .25 from the old modelLoader, now actually
honored). Keep the three vaporwave rigs exactly as staged — only the BRDF
changes. Acceptance: side-by-side with the Electron build on the example-seed
model reads "same or better".

**B4. MSAA 4× on mesh passes** (models/landscapes/scenes). Deck shader quads
don't need it; mesh silhouettes do. Resolve into the existing deck targets.

**B5. Stretch — "fun" beyond parity** (only after B1–B4 land): optional
bloom/glow pass on the master composite, and a per-deck brightness-threshold
glow toggle. Cheap on wgpu, big stage presence — but parity first.

## Workstream C — Felt performance

**C1. Monitors back to 60 fps.**
Replace base64-JPEG monitor events with Tauri 2 **raw IPC channels**
(`tauri::ipc::Channel<InvokeResponseBody::Raw>` — binary, no JSON/base64) and
draw via `ImageData`/`createImageBitmap`. Target: A/B monitors at 60 fps,
512×288 or higher; previews can stay round-robin JPEG. Measure encode +
transfer time in C2 before/after; if raw channels alone aren't enough,
downscale on GPU before readback (already done) and skip the JPEG encode
entirely (raw RGBA at 512×288×60fps ≈ 35 MB/s in-process — fine).

**C2. Engine stats overlay (the Phase 6 leftover, now needed).**
`vizzy://engine-stats` once per second: render fps, frame time, encode time,
publish time. Tiny TopBar readout behind a dev toggle. Every other change in
this plan gets judged against these numbers plus eyes-on feel.

**C3. Frame-pacing audit with stats in hand.** Verify the render thread holds
60 fps with 8 active decks + Syphon + master window on the real machine; if
mesh passes are the cost, bump to a shared depth pre-pass or cut deck target
size only as a last resort (Electron used the same 960-wide targets).

---

## Sequencing

1. **A1 + C2** (instrumentation: failure corpus + stats) — small, ships first,
   everything else is judged by it.
2. **C1** (60 fps monitors) — biggest felt-performance win, independent.
3. **A2** (glslang path) — the structural shader fix; validate against the
   captured corpus.
4. **B1 + B2** (sRGB + textures) — the two visual heavy-hitters, together,
   since both touch texture formats.
5. **B3 + B4** (specular + MSAA), then **A3** prompt tuning against whatever
   still fails, then **B5** stretch polish.

Validation is a loop with the operator: steps 1–2 need no judgment calls;
3–5 each end with a real session on the performance machine (shader success
rate from the A1 counter, visuals side-by-side against the Electron build,
feel under live audio + MIDI).
