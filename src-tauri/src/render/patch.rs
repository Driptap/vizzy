// Structured patch ingestion: the LLM emits a JSON PatchSpec (generator +
// warps + palette + audio routing + post) instead of shader code; this module
// composes hand-written WGSL blocks into a complete deck shader module. The
// blocks are trusted and tested, so a spec that deserializes always compiles —
// field shader failures are impossible by construction (the GLSL ingest path
// this replaces died of model-emitted invalid GLSL).
//
// Numeric parameters live in a 16-vec4 uniform (group 1 binding 0), so the
// compiled pipeline depends only on the patch STRUCTURE (generator + warp
// chain + feature flags); values can change without a recompile.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wgpu::naga;

/// Floats in the patch uniform: array<vec4<f32>, 16>.
pub const PARAM_FLOATS: usize = 64;
/// Bytes of the patch uniform buffer (and its min_binding_size).
pub const PARAM_BYTES: u64 = (PARAM_FLOATS * 4) as u64;

// Param slot layout (gp(i) reads float i):
//   0..16  generator params, in the generator's declared order
//  16..28  palette cosine coefficients a/b/c/d (xyz of v[4]..v[7])
//  32..48  warp amounts (warp i amount at 32 + i*4)
//  48..50  motion: speed, rotate
//  52..59  post: trail, feedZoom, feedRotate, posterize, scanlines, grain, vignette
//  60..63  audio route amounts (route j at 60 + j)
const SLOT_GEN: usize = 0;
const SLOT_PALETTE: usize = 16;
const SLOT_WARP: usize = 32;
const SLOT_SPEED: usize = 48;
const SLOT_ROTATE: usize = 49;
const SLOT_TRAIL: usize = 52;
const SLOT_FEED_ZOOM: usize = 53;
const SLOT_FEED_ROTATE: usize = 54;
const SLOT_POSTERIZE: usize = 55;
const SLOT_SCANLINES: usize = 56;
const SLOT_GRAIN: usize = 57;
const SLOT_VIGNETTE: usize = 58;
const SLOT_ROUTE: usize = 60;

pub const MAX_WARPS: usize = 4;
pub const MAX_ROUTES: usize = 3;

// ---------------------------------------------------------------------------
// Spec model (mirrors the TS PatchSpec; unknown JSON fields are ignored)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSpec {
    pub generator: String,
    #[serde(default)]
    pub params: HashMap<String, f32>,
    #[serde(default)]
    pub palette: Option<PaletteSpec>,
    #[serde(default)]
    pub warps: Vec<WarpSpec>,
    #[serde(default)]
    pub motion: MotionSpec,
    #[serde(default)]
    pub audio: Vec<AudioRouteSpec>,
    #[serde(default)]
    pub post: PostSpec,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PaletteSpec {
    Preset {
        preset: String,
    },
    Cosine {
        a: [f32; 3],
        b: [f32; 3],
        c: [f32; 3],
        d: [f32; 3],
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WarpSpec {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub amount: Option<f32>,
    #[serde(default)]
    pub audio: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MotionSpec {
    #[serde(default)]
    pub speed: Option<f32>,
    #[serde(default)]
    pub rotate: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioRouteSpec {
    pub band: String,
    pub target: String,
    #[serde(default)]
    pub amount: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSpec {
    #[serde(default)]
    pub trail: Option<f32>,
    #[serde(default)]
    pub feed_zoom: Option<f32>,
    #[serde(default)]
    pub feed_rotate: Option<f32>,
    #[serde(default)]
    pub posterize: Option<f32>,
    #[serde(default)]
    pub scanlines: Option<f32>,
    #[serde(default)]
    pub grain: Option<f32>,
    #[serde(default)]
    pub vignette: Option<f32>,
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

struct Param {
    name: &'static str,
    default: f32,
    min: f32,
    max: f32,
}

const fn p(name: &'static str, default: f32, min: f32, max: f32) -> Param {
    Param {
        name,
        default,
        min,
        max,
    }
}

struct Generator {
    name: &'static str,
    params: &'static [Param],
    /// WGSL defining `fn gen(p: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32>`
    /// (plus any private helpers with generator-unique names).
    body: &'static str,
}

struct Warp {
    name: &'static str,
    /// WGSL fn name: fn X(p: vec2<f32>, amt: f32, t: f32) -> vec2<f32>
    func: &'static str,
    body: &'static str,
    default_amount: f32,
    min: f32,
    max: f32,
}

pub fn generator_names() -> Vec<&'static str> {
    GENERATORS.iter().map(|g| g.name).collect()
}

/// Cosine palette coefficients [a, b, c, d] (col = a + b*cos(tau*(c*t + d))).
type PaletteCoeffs = [[f32; 3]; 4];

const RAINBOW: PaletteCoeffs = [
    [0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5],
    [1.0, 1.0, 1.0],
    [0.0, 0.33, 0.67],
];

const PALETTE_PRESETS: &[(&str, PaletteCoeffs)] = &[
    ("rainbow", RAINBOW),
    (
        "synthwave",
        [
            [0.55, 0.2, 0.65],
            [0.45, 0.35, 0.35],
            [1.0, 0.8, 1.0],
            [0.9, 0.45, 0.6],
        ],
    ),
    (
        "fire",
        [
            [0.5, 0.18, 0.02],
            [0.5, 0.35, 0.1],
            [1.0, 0.9, 0.6],
            [0.0, 0.15, 0.35],
        ],
    ),
    (
        "ice",
        [
            [0.45, 0.6, 0.8],
            [0.35, 0.35, 0.3],
            [1.0, 1.0, 1.2],
            [0.55, 0.6, 0.7],
        ],
    ),
    (
        "matrix",
        [
            [0.05, 0.25, 0.08],
            [0.1, 0.5, 0.15],
            [1.2, 1.0, 1.2],
            [0.35, 0.0, 0.4],
        ],
    ),
    (
        "miami",
        [
            [0.7, 0.3, 0.6],
            [0.3, 0.45, 0.4],
            [1.0, 1.0, 0.8],
            [0.9, 0.25, 0.6],
        ],
    ),
    (
        "acid",
        [
            [0.5, 0.5, 0.3],
            [0.5, 0.5, 0.6],
            [2.0, 3.0, 1.5],
            [0.2, 0.6, 0.4],
        ],
    ),
    (
        "vapor",
        [
            [0.75, 0.6, 0.85],
            [0.25, 0.3, 0.25],
            [0.8, 0.8, 1.0],
            [0.7, 0.4, 0.85],
        ],
    ),
    (
        "lasergrid",
        [
            [0.4, 0.1, 0.5],
            [0.6, 0.4, 0.6],
            [1.5, 1.0, 1.2],
            [0.75, 0.3, 0.55],
        ],
    ),
    (
        "mono-amber",
        [
            [0.55, 0.35, 0.05],
            [0.45, 0.3, 0.05],
            [1.0, 1.0, 0.8],
            [0.0, 0.05, 0.2],
        ],
    ),
];

// ---------------------------------------------------------------------------
// WGSL prelude: bindings, shared helpers, fullscreen vertex stage.
// Orientation matches compositor.wgsl vs_fullscreen: clip y = +1 maps to
// uv.y = 0, so deck targets stay bottom-up like every other deck pass.
// ---------------------------------------------------------------------------

const PRELUDE: &str = r"
struct DeckUniforms {
  resolution: vec2<f32>,
  time: f32,
  low: f32,
  mid: f32,
  high: f32,
  level: f32,
}
@group(0) @binding(0) var<uniform> U: DeckUniforms;

struct PatchParams {
  v: array<vec4<f32>, 16>,
}
@group(1) @binding(0) var<uniform> P: PatchParams;
@group(1) @binding(1) var history: texture_2d<f32>;
@group(1) @binding(2) var hsamp: sampler;

const TAU: f32 = 6.28318530718;
const PI: f32 = 3.14159265359;

fn gp(i: u32) -> f32 {
  return P.v[i / 4u][i % 4u];
}

fn rot2(a: f32) -> mat2x2<f32> {
  return mat2x2<f32>(cos(a), sin(a), -sin(a), cos(a));
}

fn hash11(n: f32) -> f32 {
  return fract(sin(n * 127.1) * 43758.5453);
}

fn hash21(q: vec2<f32>) -> f32 {
  return fract(sin(dot(q, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn hash22(q: vec2<f32>) -> vec2<f32> {
  return fract(
    sin(vec2<f32>(dot(q, vec2<f32>(127.1, 311.7)), dot(q, vec2<f32>(269.5, 183.3)))) * 43758.5453,
  );
}

fn vnoise(q: vec2<f32>) -> f32 {
  let i = floor(q);
  let f = fract(q);
  let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(q0: vec2<f32>) -> f32 {
  var q = q0;
  var v = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 4; i++) {
    v = v + amp * vnoise(q);
    q = rot2(0.5) * q * 2.03;
    amp = amp * 0.5;
  }
  return v;
}

// Cosine palette driven by the patch coefficients (v[4]..v[7]).
fn pal(h: f32) -> vec3<f32> {
  return P.v[4].xyz + P.v[5].xyz * cos(TAU * (P.v[6].xyz * h + P.v[7].xyz));
}

// Pseudo-spectrum: band level at normalized position x in 0..1 (low -> high).
fn bandmix(x: f32) -> f32 {
  return mix(U.low, mix(U.mid, U.high, smoothstep(0.5, 1.0, x)), smoothstep(0.0, 0.5, x));
}

fn hex_dist(q: vec2<f32>) -> f32 {
  let a = abs(q);
  return max(a.x * 0.866025 + a.y * 0.5, a.y);
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_patch(@builtin(vertex_index) vi: u32) -> VsOut {
  let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vi & 2u) * 2.0 - 1.0;
  var out: VsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, -y * 0.5 + 0.5);
  return out;
}
";

// ---------------------------------------------------------------------------
// Generators. Contract: fn gen(p, uv, t) -> vec3<f32>. p is centred and
// aspect-corrected (y in -0.5..0.5), uv is raw 0..1 (bottom-left origin),
// t is speed-scaled time. Params arrive via gp(0)..gp(15) in declared order.
// ---------------------------------------------------------------------------

const GENERATORS: &[Generator] = &[
    Generator {
        name: "bars",
        params: &[
            p("count", 24.0, 4.0, 64.0),
            p("fill", 0.8, 0.3, 1.0),
            p("cap", 1.0, 0.0, 1.0),
        ],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let count = gp(0u);
  let fill = gp(1u);
  let cap = gp(2u);
  let x = uv.x * count;
  let ci = floor(x);
  let fx = fract(x);
  let xn = (ci + 0.5) / count;
  let jitter = 0.55 + 0.45 * hash11(ci + floor(t * 9.0) * 0.37);
  let h = clamp(bandmix(xn) * jitter * 1.15, 0.02, 1.0);
  let inside = step(uv.y, h) * step(abs(fx - 0.5), fill * 0.5);
  var c = pal(xn + uv.y * 0.3) * inside * (0.35 + 0.65 * uv.y / max(h, 0.001));
  let cap_y = h + 0.025 + 0.05 * U.level;
  c = c + pal(xn) * cap * step(abs(uv.y - cap_y), 0.008) * step(abs(fx - 0.5), fill * 0.5);
  return c;
}
",
    },
    Generator {
        name: "radial-spectrum",
        params: &[p("count", 32.0, 8.0, 64.0), p("inner", 0.25, 0.05, 0.6)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let count = gp(0u);
  let inner = gp(1u);
  let r = length(q);
  let a = atan2(q.y, q.x) / TAU + 0.5;
  let x = a * count;
  let ci = floor(x);
  let fx = fract(x);
  let xn = fract((ci + 0.5) / count);
  let jitter = 0.6 + 0.4 * hash11(ci + floor(t * 8.0) * 0.41);
  let h = inner + bandmix(abs(xn * 2.0 - 1.0)) * jitter * 0.4;
  let ring = step(inner, r) * step(r, h) * step(abs(fx - 0.5), 0.42);
  var c = pal(xn + t * 0.05) * ring * (0.5 + 0.5 * (r - inner) / max(h - inner, 0.001));
  c = c + pal(xn) * smoothstep(0.015, 0.0, abs(r - h)) * 0.8;
  return c;
}
",
    },
    Generator {
        name: "scope",
        params: &[p("traces", 3.0, 1.0, 5.0), p("amp", 0.35, 0.1, 0.8)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let traces = gp(0u);
  let amp = gp(1u);
  var c = vec3<f32>(0.0);
  for (var k = 0; k < 5; k++) {
    if (f32(k) >= traces) { break; }
    let fk = f32(k);
    let ph = fk * 2.1;
    let y = amp * (U.low * sin((q.x * 3.0 + t * 2.0 + ph) * 1.7)
      + U.mid * 0.7 * sin(q.x * 9.0 - t * 3.0 + ph)
      + U.high * 0.5 * sin(q.x * 23.0 + t * 5.0 + ph * 3.0)
      + 0.08 * sin(q.x * 5.0 + t + ph));
    let d = abs(q.y - y);
    let hue = fk / max(traces, 1.0);
    c = c + pal(hue + t * 0.03) * smoothstep(0.02, 0.002, d) * (0.6 + 0.4 * U.level);
    c = c + pal(hue) * 0.015 / max(d, 0.01);
  }
  return c;
}
",
    },
    Generator {
        name: "lissajous",
        params: &[
            p("fx", 3.0, 1.0, 8.0),
            p("fy", 2.0, 1.0, 8.0),
            p("glow", 1.0, 0.3, 3.0),
        ],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let lfx = floor(gp(0u));
  let lfy = floor(gp(1u));
  let glow = gp(2u);
  var dmin = 10.0;
  var hue = 0.0;
  for (var k = 0; k < 64; k++) {
    let u = f32(k) / 64.0;
    let s = vec2<f32>(
      0.65 * sin(TAU * lfx * u + t * 0.7),
      0.5 * sin(TAU * lfy * u + t * 0.9 + U.low * 1.5));
    let d = length(q - s);
    if (d < dmin) { dmin = d; hue = u; }
  }
  return pal(hue + t * 0.05)
    * (smoothstep(0.025, 0.004, dmin) + glow * 0.012 / max(dmin, 0.01))
    * (0.7 + 0.5 * U.level);
}
",
    },
    Generator {
        name: "vu-needles",
        params: &[p("needles", 2.0, 1.0, 4.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let needles = floor(gp(0u));
  var c = vec3<f32>(0.0);
  for (var k = 0; k < 4; k++) {
    if (f32(k) >= needles) { break; }
    let fk = f32(k);
    let centre = vec2<f32>(((fk + 0.5) / needles * 2.0 - 1.0) * 0.6, -0.22);
    let d0 = q - centre;
    var lvl = U.level;
    if (k == 0) { lvl = U.low; }
    if (k == 1) { lvl = U.mid; }
    if (k == 2) { lvl = U.high; }
    let ang = mix(2.6, 0.55, clamp(lvl * 1.3, 0.0, 1.0));
    let dir = vec2<f32>(cos(ang), sin(ang));
    let len = 0.16 + 0.5 / max(needles, 1.0) * 0.3;
    let h = clamp(dot(d0, dir), 0.0, len);
    let d = length(d0 - dir * h);
    c = c + pal(fk / max(needles, 1.0) + lvl * 0.3) * smoothstep(0.012, 0.003, d);
    let r = length(d0);
    let aa = atan2(d0.y, d0.x);
    let tick = step(abs(fract(aa / TAU * 24.0) - 0.5), 0.1)
      * smoothstep(0.015, 0.0, abs(r - (len + 0.035)))
      * step(0.55, aa) * step(aa, 2.6);
    c = c + vec3<f32>(0.5) * tick;
  }
  return c;
}
",
    },
    Generator {
        name: "fire-spectrum",
        params: &[p("cols", 28.0, 8.0, 64.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let cols = gp(0u);
  let ci = floor(uv.x * cols);
  let xn = (ci + 0.5) / cols;
  let jit = 0.6 + 0.4 * hash11(ci + floor(t * 10.0) * 0.31);
  let h = clamp(bandmix(xn) * jit, 0.03, 1.0);
  let flame = fbm(vec2<f32>(uv.x * 6.0, uv.y * 3.0 - t * 1.5));
  let heat = clamp(h - uv.y + flame * 0.3 * h, 0.0, 1.0);
  return pal(clamp(1.0 - heat, 0.0, 1.0)) * heat * 1.8;
}
",
    },
    Generator {
        name: "tunnel",
        params: &[
            p("rings", 8.0, 2.0, 24.0),
            p("spokes", 8.0, 0.0, 24.0),
            p("twist", 0.3, 0.0, 2.0),
        ],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let rings = gp(0u);
  let spokes = gp(1u);
  let twist = gp(2u);
  let r = max(length(q), 0.0015);
  let a = atan2(q.y, q.x);
  let depth = 0.3 / r + t * 1.5;
  let ang = a + twist / max(r, 0.05) * 0.1 + t * 0.2;
  let wall = sin(depth * rings) * 0.5 + 0.5;
  var spoke = 1.0;
  if (spokes > 0.5) { spoke = 0.55 + 0.45 * sin(ang * floor(spokes)); }
  var c = pal(depth * 0.05 + a / TAU) * wall * spoke;
  c = c * smoothstep(0.0, 0.45, r);
  return c * (1.0 + U.low * 1.2);
}
",
    },
    Generator {
        name: "starfield",
        params: &[p("layers", 3.0, 1.0, 5.0), p("density", 1.0, 0.3, 3.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let layers = gp(0u);
  let density = gp(1u);
  var c = vec3<f32>(0.0);
  for (var k = 0; k < 5; k++) {
    if (f32(k) >= layers) { break; }
    let fk = f32(k);
    let z = fract(fk / max(layers, 1.0) + t * 0.12);
    let scale = mix(18.0, 1.5, z);
    let g = q * scale + vec2<f32>(fk * 17.7, fk * 9.3);
    let cell = floor(g);
    let star = hash22(cell);
    let d = length(fract(g) - vec2<f32>(0.5) - (star - vec2<f32>(0.5)) * 0.6);
    let gate = step(hash21(cell + vec2<f32>(3.7, 1.1)), 0.12 * density);
    let twinkle = 0.6 + 0.4 * sin(t * 6.0 + star.x * 40.0);
    c = c + pal(star.y * 0.4 + 0.5) * smoothstep(0.07, 0.0, d) * gate * z * twinkle;
  }
  return c * (1.0 + U.level * 0.8);
}
",
    },
    Generator {
        name: "vortex",
        params: &[p("arms", 3.0, 1.0, 8.0), p("pull", 1.0, 0.2, 3.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let arms = floor(gp(0u));
  let pull = gp(1u);
  let r = max(length(q), 0.002);
  let a = atan2(q.y, q.x) + pull / (r + 0.15) + t * 0.8;
  let swirl = sin(a * arms + log(r) * 5.0 - t * 3.0);
  var c = pal(r - t * 0.1 + swirl * 0.1) * (0.5 + 0.5 * swirl);
  c = c * smoothstep(0.0, 0.3, r) * exp(-r * 0.7);
  return c * (1.3 + U.level * 1.2);
}
",
    },
    Generator {
        name: "synthwave-grid",
        params: &[p("gridScale", 8.0, 4.0, 20.0), p("sun", 1.0, 0.0, 1.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  var c = vec3<f32>(0.0);
  let gscale = gp(0u);
  let sun = gp(1u);
  if (q.y < 0.0) {
    let py = 0.02 - q.y;
    let gz = 1.0 / py;
    let gx = q.x * gz;
    let lx = abs(fract(gx * gscale * 0.1) - 0.5);
    let lz = abs(fract(gz * 0.5 + t * 1.2) - 0.5);
    let line = smoothstep(0.08, 0.0, min(lx, lz) * py * 5.0);
    c = pal(0.85 + lz * 0.1) * line * smoothstep(0.0, 0.12, py) * (1.0 + U.low);
  } else {
    let sp = q - vec2<f32>(0.0, 0.28);
    let sr = length(sp);
    var s = smoothstep(0.26, 0.25, sr) * sun;
    s = s * step(0.0, sin(sp.y * 70.0 + t) + (sp.y + 0.08) * 9.0);
    c = pal(fract(0.05 + sp.y * 0.8)) * s * (1.2 + U.mid);
    let cell = floor(q * 24.0);
    let starpos = length(fract(q * 24.0) - vec2<f32>(0.5));
    c = c + vec3<f32>(0.7) * step(hash21(cell), 0.04) * smoothstep(0.35, 0.0, starpos)
      * (0.5 + 0.5 * sin(t * 4.0 + hash21(cell) * 20.0));
  }
  return c;
}
",
    },
    Generator {
        name: "plasma",
        params: &[p("freq", 3.0, 1.0, 8.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let freq = gp(0u);
  var v = sin(q.x * freq + t);
  v = v + sin((q.y * freq + t) * 0.8);
  v = v + sin((q.x + q.y) * freq * 0.6 + t * 1.3);
  let cx = q + 0.5 * vec2<f32>(sin(t * 0.7), cos(t * 0.9));
  v = v + sin(length(cx) * freq * 1.2 - t);
  v = v * 0.25;
  var c = pal(v + t * 0.04) * (0.65 + 0.35 * sin(v * TAU + t));
  return c * (0.8 + 0.5 * U.level);
}
",
    },
    Generator {
        name: "copper-bars",
        params: &[p("bars", 7.0, 3.0, 16.0), p("gloss", 1.0, 0.2, 2.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let bars = gp(0u);
  let gloss = gp(1u);
  var c = vec3<f32>(0.0);
  for (var k = 0; k < 16; k++) {
    if (f32(k) >= bars) { break; }
    let fk = f32(k);
    let yk = 0.4 * sin(t * (0.7 + fk * 0.13) + fk * 1.7) * (0.6 + 0.4 * U.low);
    let d = abs(q.y - yk);
    let w = 0.05 + 0.02 * sin(fk * 3.0);
    let body = smoothstep(w, 0.0, d);
    c = c + pal(fk / max(bars, 1.0)) * (body * 0.7 + pow(body, 4.0) * gloss);
  }
  return c;
}
",
    },
    Generator {
        name: "interference",
        params: &[p("sources", 3.0, 2.0, 5.0), p("freq", 24.0, 8.0, 60.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let sources = gp(0u);
  let freq = gp(1u);
  var v = 0.0;
  for (var k = 0; k < 5; k++) {
    if (f32(k) >= sources) { break; }
    let fk = f32(k);
    let s = 0.5 * vec2<f32>(
      sin(t * (0.4 + fk * 0.21) + fk * 2.4),
      cos(t * (0.5 + fk * 0.17) + fk * 1.3));
    v = v + sin(length(q - s) * freq - t * 2.0);
  }
  v = v / max(sources, 1.0);
  let bands = smoothstep(-0.15, 0.15, sin(v * TAU));
  return pal(v * 0.5 + 0.5) * bands * (0.7 + 0.7 * U.mid);
}
",
    },
    Generator {
        name: "noise-flow",
        params: &[p("zoom", 2.5, 1.0, 6.0), p("warp", 1.5, 0.0, 3.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let zoom = gp(0u);
  let warp = gp(1u);
  let g = q * zoom;
  let w1 = vec2<f32>(fbm(g + vec2<f32>(0.0, t * 0.4)), fbm(g + vec2<f32>(5.2, t * 0.35)));
  let w2 = vec2<f32>(
    fbm(g + warp * w1 + vec2<f32>(1.7, 9.2)),
    fbm(g + warp * w1 + vec2<f32>(8.3, 2.8)));
  let v = fbm(g + warp * w2 + vec2<f32>(t * 0.2, 0.0));
  return pal(v * 1.4 + length(w1) * 0.4 + t * 0.02) * (0.25 + 1.5 * v * v + U.level * v);
}
",
    },
    Generator {
        name: "metaballs",
        params: &[p("blobs", 6.0, 3.0, 10.0), p("size", 1.0, 0.4, 2.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let blobs = gp(0u);
  let size = gp(1u);
  var field = 0.0;
  var hue = 0.0;
  for (var k = 0; k < 10; k++) {
    if (f32(k) >= blobs) { break; }
    let fk = f32(k);
    let s = vec2<f32>(
      0.55 * sin(t * (0.5 + 0.11 * fk) + fk * 2.39),
      0.38 * cos(t * (0.4 + 0.09 * fk) + fk * 1.7));
    let d = q - s;
    let f = 0.01 * size * (1.0 + U.low * 0.8) / max(dot(d, d), 0.0004);
    field = field + f;
    hue = hue + f * fk;
  }
  let m = smoothstep(0.9, 1.25, field);
  let rim = smoothstep(0.9, 1.0, field) - smoothstep(1.1, 1.3, field);
  return pal(hue / max(field, 0.001) * 0.13 + t * 0.03) * m + vec3<f32>(rim * 0.35);
}
",
    },
    Generator {
        name: "caustics",
        params: &[p("scale", 6.0, 2.0, 12.0)],
        body: r"
fn gen(q0: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let scale = gp(0u);
  var q = q0 * scale;
  var v = 0.0;
  for (var k = 0; k < 4; k++) {
    let fk = f32(k);
    q = rot2(0.7 + fk * 0.3) * q + vec2<f32>(t * 0.35, -t * 0.2);
    v = v + abs(sin(q.x + sin(q.y + t * 0.5)));
  }
  let web = pow(clamp(1.0 - v * 0.25, 0.0, 1.0), 3.0);
  return pal(0.55 + web * 0.2) * (web * (2.0 + U.high * 2.0) + 0.04);
}
",
    },
    Generator {
        name: "kaleido-mandala",
        params: &[p("petals", 8.0, 3.0, 24.0), p("rings", 6.0, 2.0, 16.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let petals = max(floor(gp(0u)), 3.0);
  let rings = gp(1u);
  let r = length(q);
  var a = atan2(q.y, q.x);
  a = abs(fract(a / TAU * petals) - 0.5) * 2.0;
  let petal = sin(a * PI + sin(r * rings - t * 1.5) * 1.2);
  let ring = sin(r * rings - t * 0.8);
  var c = pal(r - t * 0.05 + a * 0.15) * smoothstep(-0.2, 0.6, petal * ring);
  return c * smoothstep(1.0, 0.35, r) * (0.7 + 0.6 * U.mid);
}
",
    },
    Generator {
        name: "voronoi",
        params: &[p("cells", 8.0, 3.0, 20.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let cells = gp(0u);
  let g = q * cells * 0.5 + vec2<f32>(t * 0.3, 0.0);
  let gi = floor(g);
  let gf = fract(g);
  var d1 = 8.0;
  var d2 = 8.0;
  var id = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2<f32>(f32(x), f32(y));
      let h = hash22(gi + o);
      let site = o + vec2<f32>(0.5) + 0.4 * sin(t * 0.8 + h * TAU) - gf;
      let d = dot(site, site);
      if (d < d1) { d2 = d1; d1 = d; id = hash21(gi + o); }
      else if (d < d2) { d2 = d; }
    }
  }
  let border = smoothstep(0.0, 0.07, d2 - d1);
  let flash = step(0.75, fract(id * 7.0 + t * 0.5)) * bandmix(id);
  return pal(id + t * 0.02) * (0.2 + 0.8 * clamp(flash + bandmix(id) * 0.6, 0.0, 1.0)) * border;
}
",
    },
    Generator {
        name: "truchet",
        params: &[p("tiles", 10.0, 4.0, 24.0), p("width", 0.08, 0.02, 0.2)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let tiles = gp(0u);
  let width = gp(1u);
  let g = q * tiles * 0.5;
  let gi = floor(g);
  var gf = fract(g) - vec2<f32>(0.5);
  let h = hash21(gi);
  if (h > 0.5) { gf.x = -gf.x; }
  let d1 = abs(length(gf - vec2<f32>(-0.5, -0.5)) - 0.5);
  let d2 = abs(length(gf - vec2<f32>(0.5, 0.5)) - 0.5);
  let d = min(d1, d2);
  let line = smoothstep(width, width * 0.4, d);
  let glowt = 0.5 + 0.5 * sin(t * 2.0 + (gi.x + gi.y) * 0.8);
  return pal(h + t * 0.03) * line * (0.4 + 0.6 * glowt + U.high * 0.8);
}
",
    },
    Generator {
        name: "hex-pulse",
        params: &[p("cells", 8.0, 3.0, 18.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let cells = gp(0u);
  let g = q * cells * 0.6;
  let r = vec2<f32>(1.0, 1.7320508);
  let h = r * 0.5;
  let a = (fract(g / r) - vec2<f32>(0.5)) * r;
  let b = (fract((g - h) / r) - vec2<f32>(0.5)) * r;
  var gv = a;
  if (dot(b, b) < dot(a, a)) { gv = b; }
  let cellpos = g - gv;
  let ring = fract(length(cellpos) * 0.22 - t * 0.7 - U.low * 0.5);
  let edge = smoothstep(0.5, 0.46, hex_dist(gv));
  return pal(length(cellpos) * 0.08 + t * 0.02) * edge
    * (0.12 + 0.88 * smoothstep(0.55, 0.0, ring));
}
",
    },
    Generator {
        name: "spirograph",
        params: &[
            p("a", 5.0, 1.0, 12.0),
            p("b", 3.0, 1.0, 12.0),
            p("d", 0.6, 0.2, 1.5),
        ],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let fa = max(floor(gp(0u)), 1.0);
  let fb = max(floor(gp(1u)), 1.0);
  let dd = gp(2u);
  let big = 0.55;
  let small = big * fb / fa;
  var dmin = 10.0;
  var hue = 0.0;
  for (var k = 0; k < 96; k++) {
    let u = f32(k) / 96.0 * TAU * 3.0 + t * 0.2;
    let s = vec2<f32>(
      (big - small) * cos(u) + dd * small * cos((big - small) / small * u),
      (big - small) * sin(u) - dd * small * sin((big - small) / small * u));
    let d = length(q - s * 0.8);
    if (d < dmin) { dmin = d; hue = f32(k) / 96.0; }
  }
  return pal(hue + t * 0.04)
    * (smoothstep(0.02, 0.004, dmin) + 0.012 / max(dmin, 0.01) * (0.5 + U.level));
}
",
    },
    Generator {
        name: "julia-drift",
        params: &[p("zoom", 1.4, 0.6, 3.0), p("drift", 0.5, 0.1, 1.5)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let zoom = gp(0u);
  let drift = gp(1u);
  var z = q * (2.8 / zoom);
  let c0 = 0.7885 * vec2<f32>(cos(t * 0.23 * drift + U.low * 0.4), sin(t * 0.17 * drift));
  var n = 0.0;
  var z2 = dot(z, z);
  for (var i = 0; i < 56; i++) {
    z = vec2<f32>(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c0;
    z2 = dot(z, z);
    if (z2 > 16.0) { break; }
    n = n + 1.0;
  }
  let m = n - log2(log2(max(z2, 16.0))) + 4.0;
  var c = pal(m * 0.035 + t * 0.02) * step(0.5, 56.0 - n);
  c = c * (0.4 + 0.6 * smoothstep(0.0, 12.0, m));
  return c * (1.0 + U.level * 0.6);
}
",
    },
    Generator {
        name: "kali-ifs",
        params: &[p("fold", 1.1, 0.6, 1.8)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let fold = gp(0u);
  var z = q * 1.4;
  var trap = 10.0;
  var acc = 0.0;
  for (var i = 0; i < 9; i++) {
    z = abs(z) / clamp(dot(z, z), 0.15, 2.0)
      - vec2<f32>(fold, fold * 0.78 + 0.1 * sin(t * 0.4));
    trap = min(trap, abs(z.y));
    acc = acc + length(z);
  }
  let v = pow(clamp(1.0 - trap * 2.2, 0.0, 1.0), 3.0);
  return pal(acc * 0.06 + t * 0.03) * (v * (1.2 + U.mid) + 0.03);
}
",
    },
    Generator {
        name: "matrix-rain",
        params: &[p("columns", 36.0, 12.0, 80.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let columns = gp(0u);
  let ci = floor(uv.x * columns);
  let speed = 0.25 + 0.75 * hash11(ci * 1.7);
  let rows = columns * 1.6;
  let ry = floor(uv.y * rows);
  let glyph = step(0.25, hash21(vec2<f32>(ci, ry + floor(t * 2.0))));
  let ph = fract(-uv.y * 0.8 + t * 0.35 * speed + hash11(ci) * 9.0);
  let trail = pow(ph, 4.0);
  let head = smoothstep(0.92, 1.0, ph);
  var c = (pal(0.35) * trail * 0.9 + vec3<f32>(0.7, 1.0, 0.8) * head) * glyph;
  return c * (0.7 + 0.6 * bandmix(hash11(ci)));
}
",
    },
    Generator {
        name: "atari-diamonds",
        params: &[p("rings", 10.0, 3.0, 24.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let rings = gp(0u);
  let d = abs(q.x) + abs(q.y);
  let v = d * rings - t * 2.0 - U.low * 2.0;
  var c = pal(floor(v) * 0.13 + t * 0.01) * (0.35 + 0.65 * step(fract(v), 0.8));
  return c * (smoothstep(1.4, 0.2, d) + 0.15);
}
",
    },
    Generator {
        name: "rutt-etra",
        params: &[p("lines", 56.0, 20.0, 120.0), p("depth", 0.25, 0.05, 0.6)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let lines = gp(0u);
  let depth = gp(1u);
  let f = fbm(vec2<f32>(q.x * 1.6, uv.y * 2.2 - t * 0.5))
    + U.low * 0.6 * exp(-q.x * q.x * 3.0);
  let yy = uv.y - depth * f;
  let ly = abs(fract(yy * lines) - 0.5);
  let line = smoothstep(0.18, 0.02, ly);
  return pal(f * 0.8 + 0.1) * line * (0.3 + f * 1.1);
}
",
    },
    Generator {
        name: "vhs",
        params: &[p("noise", 0.5, 0.0, 1.0)],
        body: r"
fn gen(q: vec2<f32>, uv: vec2<f32>, t: f32) -> vec3<f32> {
  let namt = gp(0u);
  let band_y = fract(uv.y + t * 0.13);
  let tracking = smoothstep(0.12, 0.0, abs(band_y - 0.5));
  let jx = (hash21(vec2<f32>(floor(uv.y * 90.0), floor(t * 24.0))) - 0.5) * tracking * 0.2;
  let uvx = fract(uv.x + jx);
  var c = pal(floor(uvx * 7.0) / 7.0 + floor(t * 0.25) * 0.13)
    * (0.75 + 0.25 * sin(uv.y * 480.0));
  let n = hash21(vec2<f32>(floor(uv.x * 320.0), floor(uv.y * 240.0)) + vec2<f32>(floor(t * 30.0)));
  c = mix(c, vec3<f32>(n), namt * (0.15 + 0.6 * tracking));
  return c * (0.8 + 0.4 * U.level);
}
",
    },
];

// ---------------------------------------------------------------------------
// Warps: fn(p, amount, t) -> p', applied in spec order before the generator.
// ---------------------------------------------------------------------------

const WARPS: &[Warp] = &[
    Warp {
        name: "mirror",
        func: "warp_mirror",
        body: r"
fn warp_mirror(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  return vec2<f32>(abs(q.x), q.y);
}
",
        default_amount: 1.0,
        min: 0.0,
        max: 1.0,
    },
    Warp {
        name: "kaleido",
        func: "warp_kaleido",
        body: r"
fn warp_kaleido(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  let n = clamp(floor(amt), 2.0, 24.0);
  let seg = TAU / n;
  var a = atan2(q.y, q.x);
  a = a - seg * floor(a / seg);
  a = abs(a - seg * 0.5);
  return vec2<f32>(cos(a), sin(a)) * length(q);
}
",
        default_amount: 6.0,
        min: 2.0,
        max: 24.0,
    },
    Warp {
        name: "swirl",
        func: "warp_swirl",
        body: r"
fn warp_swirl(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  let r = length(q);
  return rot2(amt * (1.0 - smoothstep(0.0, 1.2, r)) * 2.0) * q;
}
",
        default_amount: 0.5,
        min: -3.0,
        max: 3.0,
    },
    Warp {
        name: "fisheye",
        func: "warp_fisheye",
        body: r"
fn warp_fisheye(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  let r = max(length(q), 0.0001);
  return q * pow(r, amt * 0.8) / r;
}
",
        default_amount: 0.5,
        min: -1.0,
        max: 2.0,
    },
    Warp {
        name: "ripple",
        func: "warp_ripple",
        body: r"
fn warp_ripple(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  let r = length(q);
  let dir = q / max(r, 0.0001);
  return q + dir * sin(r * 18.0 - t * 4.0) * amt * 0.04;
}
",
        default_amount: 0.5,
        min: 0.0,
        max: 2.0,
    },
    Warp {
        name: "zoomPulse",
        func: "warp_zoompulse",
        body: r"
fn warp_zoompulse(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  return q / (1.0 + 0.25 * amt * sin(t * 2.0));
}
",
        default_amount: 0.5,
        min: 0.0,
        max: 2.0,
    },
    Warp {
        name: "scroll",
        func: "warp_scroll",
        body: r"
fn warp_scroll(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  return vec2<f32>(q.x + t * amt * 0.3, q.y);
}
",
        default_amount: 1.0,
        min: -4.0,
        max: 4.0,
    },
    Warp {
        name: "polar",
        func: "warp_polar",
        body: r"
fn warp_polar(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  let r = length(q);
  let a = atan2(q.y, q.x);
  return mix(q, vec2<f32>(a / PI, (r - 0.5) * 2.0), clamp(amt, 0.0, 1.0));
}
",
        default_amount: 1.0,
        min: 0.0,
        max: 1.0,
    },
    Warp {
        name: "tile",
        func: "warp_tile",
        body: r"
fn warp_tile(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  let n = max(amt, 1.0);
  return (fract(q * n) - vec2<f32>(0.5)) * 2.0;
}
",
        default_amount: 2.0,
        min: 1.0,
        max: 8.0,
    },
    Warp {
        name: "pixelate",
        func: "warp_pixelate",
        body: r"
fn warp_pixelate(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  let n = mix(160.0, 12.0, clamp(amt, 0.0, 1.0));
  return floor(q * n) / n;
}
",
        default_amount: 0.5,
        min: 0.0,
        max: 1.0,
    },
    Warp {
        name: "shear",
        func: "warp_shear",
        body: r"
fn warp_shear(q: vec2<f32>, amt: f32, t: f32) -> vec2<f32> {
  return vec2<f32>(q.x + q.y * amt * 0.6 * sin(t * 1.3), q.y);
}
",
        default_amount: 0.5,
        min: 0.0,
        max: 2.0,
    },
];

fn band_expr(band: &str) -> Option<&'static str> {
    match band {
        "low" => Some("U.low"),
        "mid" => Some("U.mid"),
        "high" => Some("U.high"),
        "level" => Some("U.level"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ComposedPatch {
    pub module: naga::Module,
    pub params: [f32; PARAM_FLOATS],
    pub uses_history: bool,
}

/// Compose a spec into WGSL source + params. Exposed separately from
/// [`compose`] so tests can inspect the source and params without a parse.
pub fn compose_source(spec: &PatchSpec) -> Result<(String, [f32; PARAM_FLOATS], bool), String> {
    let generator = GENERATORS
        .iter()
        .find(|g| g.name == spec.generator)
        .ok_or_else(|| {
            format!(
                "Unknown generator \"{}\". Valid generators: {}",
                spec.generator,
                generator_names().join(", ")
            )
        })?;

    let mut params = [0.0f32; PARAM_FLOATS];

    for (i, decl) in generator.params.iter().enumerate().take(16) {
        let raw = spec.params.get(decl.name).copied().unwrap_or(decl.default);
        let raw = if raw.is_finite() { raw } else { decl.default };
        params[SLOT_GEN + i] = raw.clamp(decl.min, decl.max);
    }

    let coeffs = resolve_palette(spec.palette.as_ref());
    for (row, coeff) in coeffs.iter().enumerate() {
        for (col, v) in coeff.iter().enumerate() {
            params[SLOT_PALETTE + row * 4 + col] = v.clamp(-4.0, 4.0);
        }
    }

    // Warps: unknown types are skipped (the TS validator already warned), so a
    // typo degrades to "no warp" rather than a dead deck.
    let warps: Vec<(&Warp, &WarpSpec)> = spec
        .warps
        .iter()
        .filter_map(|w| WARPS.iter().find(|d| d.name == w.kind).map(|d| (d, w)))
        .take(MAX_WARPS)
        .collect();
    for (i, (def, w)) in warps.iter().enumerate() {
        let amount = w.amount.unwrap_or(def.default_amount);
        let amount = if amount.is_finite() {
            amount
        } else {
            def.default_amount
        };
        params[SLOT_WARP + i * 4] = amount.clamp(def.min, def.max);
    }

    params[SLOT_SPEED] = spec
        .motion
        .speed
        .filter(|v| v.is_finite())
        .unwrap_or(1.0)
        .clamp(0.0, 4.0);
    params[SLOT_ROTATE] = spec
        .motion
        .rotate
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
        .clamp(-2.0, 2.0);

    let post = &spec.post;
    let pv = |v: Option<f32>, default: f32, min: f32, max: f32| {
        v.filter(|x| x.is_finite())
            .unwrap_or(default)
            .clamp(min, max)
    };
    params[SLOT_TRAIL] = pv(post.trail, 0.0, 0.0, 0.97);
    params[SLOT_FEED_ZOOM] = pv(post.feed_zoom, 1.0, 0.8, 1.25);
    params[SLOT_FEED_ROTATE] = pv(post.feed_rotate, 0.0, -0.2, 0.2);
    params[SLOT_POSTERIZE] = pv(post.posterize, 0.0, 0.0, 1.0);
    params[SLOT_SCANLINES] = pv(post.scanlines, 0.0, 0.0, 1.0);
    params[SLOT_GRAIN] = pv(post.grain, 0.0, 0.0, 1.0);
    params[SLOT_VIGNETTE] = pv(post.vignette, 0.0, 0.0, 1.0);

    let uses_history = params[SLOT_TRAIL] > 0.005;

    // Audio routes: unknown bands/targets are skipped.
    let routes: Vec<(&'static str, &str, usize)> = spec
        .audio
        .iter()
        .filter_map(|r| {
            band_expr(&r.band).and_then(|b| match r.target.as_str() {
                "scale" | "brightness" | "speed" => Some((b, r.target.as_str(), r.amount)),
                _ => None,
            })
        })
        .enumerate()
        .map(|(j, (b, target, amount))| {
            let amount = if amount.is_finite() { amount } else { 0.0 };
            params[SLOT_ROUTE + j] = amount.clamp(0.0, 2.0);
            (b, target, j)
        })
        .take(MAX_ROUTES)
        .collect();

    // ---- assemble the module source ----
    let mut src = String::with_capacity(8192);
    src.push_str(PRELUDE);
    src.push_str(generator.body);
    let mut emitted: Vec<&str> = Vec::new();
    for (def, _) in &warps {
        if !emitted.contains(&def.func) {
            src.push_str(def.body);
            emitted.push(def.func);
        }
    }

    src.push_str(
        "@fragment\nfn fs_patch(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {\n",
    );
    src.push_str("  var m_bright = 1.0;\n  var m_scale = 1.0;\n");
    src.push_str(&format!("  var t = U.time * gp({SLOT_SPEED}u);\n"));
    for (band, target, j) in &routes {
        let amt = format!("gp({}u)", SLOT_ROUTE + j);
        match *target {
            "scale" => src.push_str(&format!("  m_scale = m_scale + {band} * {amt} * 0.5;\n")),
            "brightness" => src.push_str(&format!("  m_bright = m_bright + {band} * {amt};\n")),
            _ => src.push_str(&format!("  t = t + {band} * {amt} * 0.5;\n")),
        }
    }
    src.push_str(
        "  var p = (uv - vec2<f32>(0.5)) * vec2<f32>(U.resolution.x / max(U.resolution.y, 1.0), 1.0);\n",
    );
    src.push_str("  p = p / max(m_scale, 0.05);\n");
    src.push_str(&format!("  p = rot2(gp({SLOT_ROTATE}u) * t) * p;\n"));
    for (i, (def, w)) in warps.iter().enumerate() {
        let slot = SLOT_WARP + i * 4;
        let amt = match w.audio.as_deref().and_then(band_expr) {
            Some(band) => format!("gp({slot}u) * (0.25 + 1.5 * {band})"),
            None => format!("gp({slot}u)"),
        };
        src.push_str(&format!("  p = {}(p, {amt}, t);\n", def.func));
    }
    src.push_str("  var col = gen(p, uv, t);\n  col = col * m_bright;\n");

    if uses_history {
        src.push_str(&format!(
            "  var hq = uv - vec2<f32>(0.5);\n  hq = rot2(gp({SLOT_FEED_ROTATE}u)) * hq;\n  hq = hq / max(gp({SLOT_FEED_ZOOM}u), 0.05);\n  let prev = textureSample(history, hsamp, hq + vec2<f32>(0.5));\n  col = max(col, prev.rgb * gp({SLOT_TRAIL}u));\n"
        ));
    }

    src.push_str(&format!(
        r"  let pz = gp({SLOT_POSTERIZE}u);
  if (pz > 0.01) {{
    let lv = mix(16.0, 3.0, clamp(pz, 0.0, 1.0));
    col = floor(col * lv) / lv;
  }}
  let sl = gp({SLOT_SCANLINES}u);
  if (sl > 0.01) {{
    col = col * (1.0 - sl * 0.45 * (0.5 + 0.5 * sin(uv.y * U.resolution.y * PI)));
  }}
  let gr = gp({SLOT_GRAIN}u);
  if (gr > 0.01) {{
    col = col + vec3<f32>((hash21(uv * 947.13 + vec2<f32>(fract(U.time) * 31.7)) - 0.5) * gr * 0.25);
  }}
  let vg = gp({SLOT_VIGNETTE}u);
  if (vg > 0.01) {{
    col = col * (1.0 - vg * smoothstep(0.35, 0.85, length(uv - vec2<f32>(0.5))));
  }}
"
    ));
    src.push_str("  col = clamp(col, vec3<f32>(0.0), vec3<f32>(6.0));\n");
    src.push_str("  return vec4<f32>(col, 1.0);\n}\n");

    Ok((src, params, uses_history))
}

fn resolve_palette(palette: Option<&PaletteSpec>) -> PaletteCoeffs {
    match palette {
        Some(PaletteSpec::Preset { preset }) => PALETTE_PRESETS
            .iter()
            .find(|(n, _)| n == preset)
            .map(|(_, c)| *c)
            .unwrap_or(RAINBOW),
        Some(PaletteSpec::Cosine { a, b, c, d }) => [*a, *b, *c, *d],
        None => RAINBOW,
    }
}

/// Compose + parse + validate. The source is generated from trusted blocks,
/// so an error here is a Vizzy bug, not a model failure — but it still
/// returns Err (with the source line context) rather than panicking.
pub fn compose(spec: &PatchSpec) -> Result<ComposedPatch, String> {
    let (source, params, uses_history) = compose_source(spec)?;
    let module = naga::front::wgsl::parse_str(&source).map_err(|e| {
        format!(
            "patch compose error (internal): {}",
            e.emit_to_string(&source)
        )
    })?;
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .map_err(|e| {
        format!(
            "patch validation error (internal): {}",
            e.emit_to_string(&source)
        )
    })?;
    Ok(ComposedPatch {
        module,
        params,
        uses_history,
    })
}

// ---------------------------------------------------------------------------
// Boot patches: one per slot, varied so a fresh rig shows the range. The TS
// side mirrors this list (DEFAULT_DECK_PATCHES) for RESET.
// ---------------------------------------------------------------------------

pub fn default_patch(slot: usize) -> PatchSpec {
    let (generator, preset, route): (&str, &str, Option<(&str, &str, f32)>) = match slot % 8 {
        0 => ("plasma", "rainbow", Some(("level", "brightness", 0.6))),
        1 => ("tunnel", "synthwave", Some(("low", "speed", 0.5))),
        2 => ("bars", "miami", None),
        3 => ("noise-flow", "vapor", Some(("level", "brightness", 0.5))),
        4 => ("starfield", "ice", Some(("high", "brightness", 0.6))),
        5 => ("kaleido-mandala", "lasergrid", Some(("low", "scale", 0.4))),
        6 => ("metaballs", "fire", None),
        _ => ("interference", "acid", Some(("mid", "brightness", 0.5))),
    };
    PatchSpec {
        generator: generator.into(),
        palette: Some(PaletteSpec::Preset {
            preset: preset.into(),
        }),
        audio: route
            .map(|(band, target, amount)| {
                vec![AudioRouteSpec {
                    band: band.into(),
                    target: target.into(),
                    amount,
                }]
            })
            .unwrap_or_default(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(generator: &str) -> PatchSpec {
        PatchSpec {
            generator: generator.into(),
            ..Default::default()
        }
    }

    #[test]
    fn every_generator_composes_and_validates() {
        for g in GENERATORS {
            if let Err(e) = compose(&spec(g.name)) {
                panic!("generator {} failed:\n{e}", g.name);
            }
        }
    }

    #[test]
    fn every_warp_composes_with_every_band() {
        for w in WARPS {
            let mut s = spec("plasma");
            s.warps = vec![WarpSpec {
                kind: w.name.into(),
                amount: None,
                audio: Some("low".into()),
            }];
            if let Err(e) = compose(&s) {
                panic!("warp {} failed:\n{e}", w.name);
            }
        }
    }

    #[test]
    fn full_feature_patch_validates() {
        let mut s = spec("tunnel");
        s.warps = vec![
            WarpSpec {
                kind: "kaleido".into(),
                amount: Some(8.0),
                audio: None,
            },
            WarpSpec {
                kind: "swirl".into(),
                amount: Some(0.7),
                audio: Some("mid".into()),
            },
        ];
        s.audio = vec![
            AudioRouteSpec {
                band: "low".into(),
                target: "scale".into(),
                amount: 0.8,
            },
            AudioRouteSpec {
                band: "high".into(),
                target: "brightness".into(),
                amount: 0.5,
            },
            AudioRouteSpec {
                band: "level".into(),
                target: "speed".into(),
                amount: 0.4,
            },
        ];
        s.post = PostSpec {
            trail: Some(0.85),
            feed_zoom: Some(1.02),
            feed_rotate: Some(0.01),
            posterize: Some(0.3),
            scanlines: Some(0.4),
            grain: Some(0.2),
            vignette: Some(0.5),
        };
        let composed = compose(&s).expect("full feature patch should compose");
        assert!(composed.uses_history);
    }

    #[test]
    fn trail_gates_history_usage() {
        let composed = compose(&spec("plasma")).unwrap();
        assert!(!composed.uses_history);
        let (src, _, _) = compose_source(&spec("plasma")).unwrap();
        assert!(!src.contains("textureSample"));

        let mut s = spec("plasma");
        s.post.trail = Some(0.8);
        let composed = compose(&s).unwrap();
        assert!(composed.uses_history);
        let (src, _, _) = compose_source(&s).unwrap();
        assert!(src.contains("textureSample"));
    }

    #[test]
    fn unknown_generator_lists_valid_names() {
        let err = compose(&spec("does-not-exist")).unwrap_err();
        assert!(err.contains("does-not-exist"));
        assert!(err.contains("plasma"));
        assert!(err.contains("julia-drift"));
    }

    #[test]
    fn unknown_warps_and_routes_are_skipped() {
        let mut s = spec("bars");
        s.warps = vec![WarpSpec {
            kind: "nonexistent".into(),
            amount: Some(1.0),
            audio: None,
        }];
        s.audio = vec![AudioRouteSpec {
            band: "sub-bass".into(),
            target: "hue".into(),
            amount: 1.0,
        }];
        compose(&s).expect("unknown warps/routes should degrade, not fail");
    }

    #[test]
    fn params_clamp_and_default() {
        let mut s = spec("bars");
        s.params.insert("count".into(), 9999.0);
        s.params.insert("fill".into(), f32::NAN);
        s.params.insert("unknownKnob".into(), 5.0);
        let (_, params, _) = compose_source(&s).unwrap();
        assert_eq!(params[0], 64.0); // count clamped to max
        assert_eq!(params[1], 0.8); // NaN falls back to default
        assert_eq!(params[48], 1.0); // speed default
    }

    #[test]
    fn palette_presets_fill_coefficients() {
        let mut s = spec("plasma");
        s.palette = Some(PaletteSpec::Preset {
            preset: "fire".into(),
        });
        let (_, params, _) = compose_source(&s).unwrap();
        assert!((params[16] - 0.5).abs() < 1e-6);

        s.palette = Some(PaletteSpec::Preset {
            preset: "no-such-palette".into(),
        });
        let (_, params, _) = compose_source(&s).unwrap();
        assert!((params[28] - 0.0).abs() < 1e-6); // rainbow d.x fallback
    }

    #[test]
    fn spec_deserializes_from_llm_style_json() {
        let json = r#"{
            "generator": "bars",
            "params": {"count": 32, "fill": 0.7},
            "palette": {"preset": "synthwave"},
            "warps": [{"type": "mirror"}, {"type": "swirl", "amount": 0.4, "audio": "low"}],
            "motion": {"speed": 1.2},
            "audio": [{"band": "low", "target": "scale", "amount": 0.8}],
            "post": {"trail": 0.8, "feedZoom": 1.02},
            "somethingExtra": true
        }"#;
        let s: PatchSpec = serde_json::from_str(json).expect("LLM-shaped JSON should deserialize");
        let composed = compose(&s).expect("and compose");
        assert!(composed.uses_history);
    }

    #[test]
    fn cosine_palette_passes_through() {
        let mut s = spec("plasma");
        s.palette = Some(PaletteSpec::Cosine {
            a: [0.1, 0.2, 0.3],
            b: [0.4, 0.5, 0.6],
            c: [1.0, 1.0, 1.0],
            d: [0.0, 0.1, 0.2],
        });
        let (_, params, _) = compose_source(&s).unwrap();
        assert!((params[17] - 0.2).abs() < 1e-6);
    }

    #[test]
    fn default_patches_compose_for_all_slots() {
        for slot in 0..8 {
            let s = default_patch(slot);
            if let Err(e) = compose(&s) {
                panic!("default patch for slot {slot} failed:\n{e}");
            }
        }
    }
}
