# Shader Generation Rework — from raw GLSL to a structured patch spec

Status: **G0–G3 implemented 2026-06-13** — supersedes Workstream A2/A3 of
`3D_QUALITY_PLAN.md`. The composer (`src-tauri/src/render/patch.rs`) ships the
full Wave-1 catalog (27 generators, 11 warps, 10 palette presets, feedback
trails); generation runs through `PATCH_SYSTEM_PROMPT` + Ollama structured
outputs; the GLSL ingest/sanitizer/repair path and naga glsl-in are deleted.
Remaining: G4 stretch (waveform tap, simulation generators, expr→WGSL hook,
MIDI-targetable params) and the operator's field validation — the three
corpus prompts are the acceptance test.

## The evidence

Three real failures from field use (operator-collected, 2026-06-12):

| Prompt | Error | Root cause |
|---|---|---|
| "equalizer vector lines" | `Unknown variable: colortex` at `texture2D(colortex, …)` | Model hallucinated a feedback sampler (Shadertoy `iChannel` habit). Invalid GLSL under **any** compiler. |
| "apple tunnel visualizer" | `Unknown function 'mix'` at `mix(gl_FragColor.rgb, vec4(col,…)` | `mix(vec3, vec4, …)` — no such overload. Invalid GLSL under **any** compiler. naga reports the failed overload as "unknown function", which poisons the repair loop. |
| "winamp style equaliser" | `Unexpected runtime-expression` at `const vec2 offset = vec2(cos(u_time…)` | `const` with a non-constant initializer — illegal per spec, rejected by ANGLE and glslang too. Only this one is sanitizer-fixable. |

**What this corpus proves:** the failures are not naga `glsl-in` being weaker
than ANGLE — two of three are invalid GLSL that every compiler rejects, and
the third is rejected by glslang as well. The planned A2 fix
(glslang→SPIR-V→naga spv-in) would have rescued **zero of three**. The real
bottleneck is that small local models cannot reliably emit strictly-valid
GLSL, and no compiler swap fixes the model.

(Why Electron felt better with the same model: ANGLE's compile errors are
precise — `no matching overload for mix(vec3, vec4, float)` — so the repair
loop usually converged on the second attempt, and ANGLE tolerates a few
out-of-spec slips naga rejects. Electron wasn't getting better code; it was
recovering from bad code better. The patch approach removes the need to
recover at all.)

Meanwhile the procedural scene path — LLM emits a strict JSON `SceneSpec`,
`lib/expr.ts` compiles a whitelisted math expression, trusted code builds the
geometry — works essentially every time, on the same models. Small models are
good at filling in structured specs and bad at writing compilable programs.
That is the architecture to generalize.

## The approach: VisualSpec ("patch")

The LLM stops writing shader code. Instead it emits a JSON **patch** that
composes hand-written, tested WGSL building blocks — the same contract shape
as `SceneSpec`, scaled up:

```json
{
  "generator": "bars",
  "params": { "count": 32, "thickness": 0.7, "peakHold": true },
  "palette": { "type": "cosine", "a": [0.5,0.5,0.5], "b": [0.5,0.5,0.5],
               "c": [1.0,1.0,1.0], "d": [0.0,0.33,0.67] },
  "warps": [
    { "type": "kaleido", "amount": 6 },
    { "type": "swirl", "amount": 0.4, "audio": "low" }
  ],
  "motion": { "speed": 1.2, "rotate": 0.1, "pulse": "level" },
  "audio": { "low": { "target": "scale", "amount": 0.8 },
             "high": { "target": "brightness", "amount": 0.5 } },
  "post": { "trail": 0.85, "posterize": 0, "scanlines": 0.0 }
}
```

- **Generators**: the base field. The catalog below is mined from the
  classic-visualizer canon — each is a short, hand-polished WGSL function
  with a small param struct, written once, fun by construction.
- **Warps** (ordered domain modifiers): mirror, kaleido(n), swirl,
  fisheye/barrel, ripple, zoom-pulse, scroll, polar wrap, tile/repeat,
  shear-wobble, pixelate. Composable in spec order; each optionally
  audio-modulated.
- **Palette**: named presets (`synthwave`, `fire`, `ice`, `matrix`, `miami`,
  `acid`, `vapor`, `lasergrid`, `mono-amber`, `rainbow`) — the easiest thing
  for a small model to pick well — plus custom IQ cosine coefficients or hex
  stops for when it has an opinion. All linearized like the scene palettes.
- **Audio routing** is first-class data, not something the model has to wire
  in code — every patch is audio-reactive by construction.
- **Post / feedback**: a per-deck ping-pong history texture gives real
  feedback — the very thing the model hallucinated `colortex` for. Two modes:
  plain decay **trail**, and the MilkDrop core trick — a per-frame **feedback
  transform** (zoom/rotate/shift/warp the previous frame, draw the generator
  on top). That one technique is responsible for most of what people remember
  as "the Winamp visualizer look", and it's cheap on wgpu. Plus scanlines,
  posterize, chroma aberration, grain, vignette. The old WebGL path had none
  of this; it's a strict upgrade.

### Generator catalog

Inspiration sources: Winamp AVS presets, MilkDrop, G-Force / iTunes
visualizer, Atari Video Music, Amiga/PC demoscene effects, Rutt-Etra video
synthesis, lava lamps and op-art. Grouped into families so the system prompt
can describe them compactly. `[fb]` = needs the feedback buffer (G1),
`[wave]` = needs the raw waveform/spectrum tap (G4 audio extension).

**Spectrum & scope** (Winamp/foobar heritage — the "equalizer" prompts):
| `bars` | classic vertical spectrum bars, peak-hold caps, the Winamp EQ look |
| `radial-spectrum` | bars bent around a circle, pulsing mandala-meter |
| `scope` | oscilloscope waveform line (pseudo-waveform synthesized from the 4 bands until `[wave]` lands, then real) |
| `lissajous` | XY-scope curves looping on bass, AVS "dot plane" feel |
| `vu-needles` | big analog VU meters, skeuomorphic needle swing |
| `fire-spectrum` | spectrum bars as rising flames, classic AVS preset |

**Flight & tunnels** (demoscene): `tunnel` (procedural ring/checker tunnel),
`starfield` (hyperspace), `vortex` (twisting wormhole), `synthwave-grid`
(Tron/outrun horizon grid with sun).

**Plasma & fields** (Amiga/PC demos): `plasma` (layered sine plasma),
`copper-bars` (Amiga raster bars, glossy horizontal beams), `interference`
(moiré ring interference from drifting emitters), `noise-flow` (fbm flow
field), `metaballs` (lava-lamp blobs), `caustics` (underwater light webs).

**Geometry & mandalas** (op-art/G-Force): `kaleido-mandala` (sacred-geometry
fold), `voronoi` (stained-glass cells lighting up per band), `truchet`
(self-connecting tile maze), `hex-pulse` (hexagon grid rippling outward from
beats), `spirograph` (harmonograph curve trails).

**Fractals**: `julia-drift` (Julia set with the seed orbiting on audio),
`kali-ifs` (kaliset/IFS fold, the "fractal flame" vibe, fixed iteration
count).

**Retro hardware & glitch**: `matrix-rain` (falling glyph columns),
`atari-diamonds` (Atari Video Music expanding diamonds), `rutt-etra`
(horizontal scanlines displaced by a synthesized luma field — the Bowie
"Heroes" look), `vhs` (analog tracking noise, color bleed).

**Simulations** `[fb]` (Wave 2 / G4): `game-of-life` (cellular automaton
seeded by audio onsets), `reaction-diffusion` (Turing-pattern crawl),
`fluid-smoke` (curl-noise advected smoke), `boids` (swarming fireflies).

Wave 1 (G1) ships everything except the `[fb]`-simulation and `[wave]`
families — roughly 26 generators. With ~11 warps, ordered chains, palette
presets, audio routing, and the feedback transform, the combination space is
effectively unbounded; the few-shot examples map famous looks to patches
("winamp style" → `bars` + mirror + trail; "milkdrop" → `noise-flow` +
feedback transform zoom 1.02 rotate 0.002).

### Render side

A Rust **composer** (`render/patch.rs`) assembles the deck fragment shader
from trusted WGSL snippets: palette fn + generator fn + warp chain inlined in
spec order. All numeric params live in a uniform buffer, so:

- Structure (generator + warp set) decides the compiled pipeline; numbers are
  uniforms. Tweaking a number — by regenerate, or later by MIDI — updates
  without a recompile.
- We compile **our own WGSL** through naga's native frontend (mature, the one
  wgpu itself is built around). Combinations are unit-tested on GPU in CI
  (`--ignored` locally, like the existing corpus tests), so field compile
  failures are effectively impossible.

### Generation side

- `parseVisualSpec` in TS mirrors `parseSceneSpec`: extract JSON, validate,
  clamp every number to sane bounds, fall back per-field instead of failing
  wholesale. A patch that parses **always renders**.
- Use Ollama **structured outputs** (`format: <json-schema>` on
  `/api/generate`) so decoding is constrained to the schema — malformed JSON
  stops being a failure mode at the source.
- New `SYSTEM_PROMPT`: the block catalog with vivid one-line descriptions
  ("bars: vertical spectrum bars, the winamp/equalizer look") plus 2–3
  few-shot prompt→patch examples. The existing style-recipe system retargets
  naturally: a recipe becomes a few-shot patch instead of GLSL guidance.
- "Regenerate" with an error becomes near-vestigial; "regenerate" as a
  creative reroll becomes **spec mutation** — a far easier task for a small
  model than rewriting a program, and it can keep the parts the operator
  liked.

### Why not keep GLSL and harden it

- glslang→SPIR-V (old A2): fixes 0/3 of the observed corpus; adds a heavyweight
  C++ build dependency per platform for nothing.
- Sanitizer extensions (old A3): fixes 1/3 (the `const` case); hallucinated
  identifiers and type errors are not sanitizer-fixable.
- Better repair loop: still asks a small model to debug type errors from
  misleading messages; converges sometimes, never reliably, and costs a full
  extra generation each round (slow on local hardware).
- The patch approach makes the failure rate **zero by construction** and the
  output faster to generate (a patch is ~15 lines of JSON vs ~60 lines of
  GLSL — lower latency per deck on local models).

The expressivity ceiling is the honest tradeoff: a patch can only say what the
block library can render. Mitigations: the combination space is already huge
(~26 generators × ordered warp chains × feedback transforms × palettes ×
audio routings), the library grows cheaply (a new generator is ~30 lines of
WGSL), and G4's expression hook re-opens unbounded territory safely.

## Phases

**G0 — Composer spike (no LLM).** `render/patch.rs` + `content`-style WGSL
snippet library with 3 generators (`bars`, `tunnel`, `plasma`), 2 warps,
cosine palette, audio routing. Hand-write the three patches the failed prompts
*wanted* and stage them on real decks. Acceptance: all three render, react to
audio, and look at least as fun as the old Electron GLSL decks. This de-risks
the whole plan before any LLM work.

**G1 — Wave-1 library + feedback.** The full Wave-1 catalog (~26 generators,
~11 warps, palette presets); per-deck ping-pong buffer powering both decay
trails and the MilkDrop feedback transform; pairwise generator×warp GPU
compile tests in the ignored suite. Defaults: `DEFAULT_DECK_BODIES` →
`DEFAULT_DECK_PATCHES` (the four baseline decks become hand-written patches).

**G2 — LLM integration.** `parseVisualSpec` + JSON-schema structured output +
new system prompt + few-shots; recipes retargeted; deck library entries store
patches; regenerate = mutate. The TopBar generation flow is unchanged from the
operator's seat — type a prompt, get a visual, just reliably now.

**G3 — Demolition** (per no-backward-compatibility): delete `ingest.rs`'s
GLSL path, the sanitizer, the repair-loop plumbing, the GLSL `SYSTEM_PROMPT`,
and the `glsl` feature from the wgpu dependency. Old GLSL library entries die
with it (clean slate confirmed). Workstream A1's failure-corpus logging is no
longer needed and is not built.

**G4 — Stretch.**
- **Waveform/spectrum tap**: extend the in-process audio share (the
  `RawLevels` Arc) with a small waveform + spectrum array so `scope`,
  `lissajous`, and `bars` graduate from band-synthesized to true signal —
  the last fidelity gap versus a real Winamp scope.
- **Simulation generators** `[fb]`: `game-of-life`, `reaction-diffusion`,
  `fluid-smoke`, `boids` — feedback-buffer state machines, the deepest
  "alive" looks in the catalog.
- **Expression hook**: optional spec fields (e.g. a custom field function
  `"field": "sin(x*8.0 + t) * cos(y*3.0)"`) compiled by an expr-grammar →
  WGSL transpiler (port of `lib/expr.ts`'s whitelist grammar, emitting WGSL
  instead of closures). Friendly parse errors, zero injection surface,
  unbounded shapes.
- **Patch params as performance surface**: since a patch is data, MIDI-learn
  can later target any patch parameter (warp amount, palette phase, trail
  length) — impossible with opaque GLSL.

## Acceptance

- The three corpus prompts ("equalizer vector lines", "apple tunnel
  visualizer", "winamp style equaliser") each produce a compiling,
  audio-reactive, good-looking deck on the first attempt.
- Generation success rate ≈ 100% by construction (A4's bar cleared); the
  judged metric shifts from *does it compile* to *does it look like the
  prompt* — validated by the operator in a real session, same loop as
  Workstream B.
