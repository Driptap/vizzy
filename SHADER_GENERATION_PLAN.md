# Shader Generation Rework — from raw GLSL to a structured patch spec

Status: **planned 2026-06-12** — supersedes Workstream A2/A3 of
`3D_QUALITY_PLAN.md`. Workstream A's goal (generation success at or above the
Electron baseline) stands; the route changes.

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

- **Generators** (the base field, ~12 to start): `bars` / `scope`
  (equalizer-style, audio-band driven), `tunnel`, `rings`, `plasma`,
  `kaleido-flow`, `starfield`, `waves`, `noise-field`, `grid`, `spiral`,
  `particles`, `metaballs`. Each is a short, hand-polished WGSL function with
  a small param struct — written once, fun by construction.
- **Warps** (ordered domain modifiers, ~8): mirror, kaleido(n), swirl, zoom-
  pulse, scroll, pixelate, ripple, fisheye. Composable; each optionally
  audio-modulated.
- **Palette**: IQ cosine palettes (4 vec3 coefficients — models are good at
  these and they always look intentional) or hex stops, linearized like the
  scene palettes.
- **Audio routing** is first-class data, not something the model has to wire
  in code — every patch is audio-reactive by construction.
- **Post / trail**: a per-deck ping-pong history texture gives real feedback
  trails — the very thing the model hallucinated `colortex` for. The old
  WebGL path never had this; it's a strict upgrade.

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
(12 generators × ordered warp chains × palettes × audio routings), the library
grows cheaply (a new generator is ~30 lines of WGSL), and G4's expression hook
re-opens unbounded territory safely.

## Phases

**G0 — Composer spike (no LLM).** `render/patch.rs` + `content`-style WGSL
snippet library with 3 generators (`bars`, `tunnel`, `plasma`), 2 warps,
cosine palette, audio routing. Hand-write the three patches the failed prompts
*wanted* and stage them on real decks. Acceptance: all three render, react to
audio, and look at least as fun as the old Electron GLSL decks. This de-risks
the whole plan before any LLM work.

**G1 — Full library + trail.** Remaining generators and warps; per-deck
ping-pong trail buffer for `post.trail`; pairwise generator×warp GPU compile
tests in the ignored suite. Defaults: `DEFAULT_DECK_BODIES` →
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
