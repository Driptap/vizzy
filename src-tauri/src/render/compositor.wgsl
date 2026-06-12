// Vizzy compositor: WGSL port of src/engine/shaders.ts (deckColor, layerStack,
// SCENE_FRAGMENT, COMPOSITE_FRAGMENT, PREVIEW_FRAGMENT).
//
// Orientation: vUv's origin is the BOTTOM-LEFT of the upright image (WebGL
// convention — LLM deck shaders assume it). vs_fullscreen maps clip y = +1
// (texture row 0) to vUv.y = 0, so every offscreen target is stored bottom-up
// and inter-pass sampling needs no flips — exactly like WebGL framebuffers.
// CPU readbacks flip rows to get an upright JPEG; the master window pass uses
// vs_present (vUv = clip * 0.5 + 0.5) so the surface displays upright.

struct Slot {
  // mix, scale, layer, unused
  a: vec4<f32>,
  // sizeX, sizeY, warpX, warpY
  b: vec4<f32>,
  // tilt (radians), contrast, hue rotation (radians), saturation
  fx: vec4<f32>,
}

struct Uniforms {
  slots: array<Slot, 8>,
  // aspect, time, xfade, unused
  globals: vec4<f32>,
  // scene select (0 = A, 1 = B), preview slot (0..7), unused, unused
  sel: vec4<f32>,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var<uniform> uni: Uniforms;
@group(0) @binding(2) var deck0: texture_2d<f32>;
@group(0) @binding(3) var deck1: texture_2d<f32>;
@group(0) @binding(4) var deck2: texture_2d<f32>;
@group(0) @binding(5) var deck3: texture_2d<f32>;
@group(0) @binding(6) var deck4: texture_2d<f32>;
@group(0) @binding(7) var deck5: texture_2d<f32>;
@group(0) @binding(8) var deck6: texture_2d<f32>;
@group(0) @binding(9) var deck7: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

// One oversized triangle: (-1,-1), (3,-1), (-1,3).
fn fullscreen_pos(vi: u32) -> vec2<f32> {
  let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vi & 2u) * 2.0 - 1.0;
  return vec2<f32>(x, y);
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> VsOut {
  let p = fullscreen_pos(vi);
  var out: VsOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  // Bottom-up storage: texture row 0 (clip y = +1) holds vUv.y = 0.
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

@vertex
fn vs_present(@builtin(vertex_index) vi: u32) -> VsOut {
  let p = fullscreen_pos(vi);
  var out: VsOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  // Window pass: reading bottom-up sources straight gives an upright image.
  out.uv = p * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

fn zoom_uv(uv: vec2<f32>, s: f32) -> vec2<f32> {
  return (uv - vec2<f32>(0.5)) / max(s, 0.001) + vec2<f32>(0.5);
}

// Returns premultiplied colour in rgb and COVERAGE in a (texture alpha masked
// by the channel window). Alpha is treated as a brightness multiplier — LLMs
// sometimes encode the shader's shape in gl_FragColor.a.
fn deck_color(tex: texture_2d<f32>, uv: vec2<f32>, zoom: f32, size: vec2<f32>, fx: vec4<f32>, warp: vec2<f32>) -> vec4<f32> {
  let aspect = uni.globals.x;
  let time = uni.globals.y;
  var local = (uv - vec2<f32>(0.5)) / max(size, vec2<f32>(0.001)) + vec2<f32>(0.5);
  let inside = step(vec2<f32>(0.0), local) * step(local, vec2<f32>(1.0));
  // Tilt rotates the content inside its axis-aligned window, aspect-corrected
  // so it spins instead of shearing.
  let tc = cos(fx.x);
  let ts = sin(fx.x);
  var q = (local - vec2<f32>(0.5)) * vec2<f32>(aspect, 1.0);
  q = mat2x2<f32>(vec2<f32>(tc, -ts), vec2<f32>(ts, tc)) * q;
  local = q / vec2<f32>(aspect, 1.0) + vec2<f32>(0.5);
  // warp: x = sine UV distortion, y = shear — both zero when idle.
  local.x = local.x + warp.y * (local.y - 0.5);
  local = local + warp.x * 0.06 * vec2<f32>(
    sin(local.y * 12.0 + time * 5.0),
    sin(local.x * 10.0 + time * 4.0)
  );
  let t = textureSampleLevel(tex, samp, zoom_uv(local, zoom), 0.0);
  var col = t.rgb * t.a;
  col = (col - vec3<f32>(0.5)) * fx.y + vec3<f32>(0.5);
  // Hue rotates RGB about the grey axis (Rodrigues).
  let hc = cos(fx.z);
  let hs = sin(fx.z);
  let k = vec3<f32>(0.57735);
  col = col * hc + cross(k, col) * hs + k * dot(k, col) * (1.0 - hc);
  let luma = dot(col, vec3<f32>(0.299, 0.587, 0.114));
  col = mix(vec3<f32>(luma), col, fx.w);
  let mask = inside.x * inside.y;
  return vec4<f32>(max(col, vec3<f32>(0.0)) * mask, t.a * mask);
}

// Layer compositor for one scene's 4 decks (already faded by their mixes).
// Layers stack 4 (base) up to 1 (top): decks SHARING a layer sum additively,
// each higher layer sits OVER the result using its coverage.
fn layer_stack(d1: vec4<f32>, d2: vec4<f32>, d3: vec4<f32>, d4: vec4<f32>, l: vec4<f32>) -> vec3<f32> {
  var acc = vec3<f32>(0.0);
  for (var layer: i32 = 4; layer >= 1; layer = layer - 1) {
    let f_l = f32(layer);
    let on1 = step(abs(l.x - f_l), 0.5);
    let on2 = step(abs(l.y - f_l), 0.5);
    let on3 = step(abs(l.z - f_l), 0.5);
    let on4 = step(abs(l.w - f_l), 0.5);
    let col = d1.rgb * on1 + d2.rgb * on2 + d3.rgb * on3 + d4.rgb * on4;
    let cov = min(1.0, d1.a * on1 + d2.a * on2 + d3.a * on3 + d4.a * on4);
    acc = col + acc * (1.0 - cov);
  }
  return acc;
}

fn stack_a(uv: vec2<f32>) -> vec3<f32> {
  let d1 = deck_color(deck0, uv, uni.slots[0].a.y, uni.slots[0].b.xy, uni.slots[0].fx, uni.slots[0].b.zw) * uni.slots[0].a.x;
  let d2 = deck_color(deck1, uv, uni.slots[1].a.y, uni.slots[1].b.xy, uni.slots[1].fx, uni.slots[1].b.zw) * uni.slots[1].a.x;
  let d3 = deck_color(deck2, uv, uni.slots[2].a.y, uni.slots[2].b.xy, uni.slots[2].fx, uni.slots[2].b.zw) * uni.slots[2].a.x;
  let d4 = deck_color(deck3, uv, uni.slots[3].a.y, uni.slots[3].b.xy, uni.slots[3].fx, uni.slots[3].b.zw) * uni.slots[3].a.x;
  return layer_stack(d1, d2, d3, d4, vec4<f32>(uni.slots[0].a.z, uni.slots[1].a.z, uni.slots[2].a.z, uni.slots[3].a.z));
}

fn stack_b(uv: vec2<f32>) -> vec3<f32> {
  let d1 = deck_color(deck4, uv, uni.slots[4].a.y, uni.slots[4].b.xy, uni.slots[4].fx, uni.slots[4].b.zw) * uni.slots[4].a.x;
  let d2 = deck_color(deck5, uv, uni.slots[5].a.y, uni.slots[5].b.xy, uni.slots[5].fx, uni.slots[5].b.zw) * uni.slots[5].a.x;
  let d3 = deck_color(deck6, uv, uni.slots[6].a.y, uni.slots[6].b.xy, uni.slots[6].fx, uni.slots[6].b.zw) * uni.slots[6].a.x;
  let d4 = deck_color(deck7, uv, uni.slots[7].a.y, uni.slots[7].b.xy, uni.slots[7].fx, uni.slots[7].b.zw) * uni.slots[7].a.x;
  return layer_stack(d1, d2, d3, d4, vec4<f32>(uni.slots[4].a.z, uni.slots[5].a.z, uni.slots[6].a.z, uni.slots[7].a.z));
}

// One scene's composite — the A/B monitor views. sel.x picks the scene.
@fragment
fn fs_scene(in: VsOut) -> @location(0) vec4<f32> {
  var c: vec3<f32>;
  if (uni.sel.x < 0.5) {
    c = stack_a(in.uv);
  } else {
    c = stack_b(in.uv);
  }
  return vec4<f32>(min(c, vec3<f32>(1.0)), 1.0);
}

// Master output: both scene stacks crossfaded by xfade (globals.z).
@fragment
fn fs_master(in: VsOut) -> @location(0) vec4<f32> {
  let a = stack_a(in.uv);
  let b = stack_b(in.uv);
  let c = a * (1.0 - uni.globals.z) + b * uni.globals.z;
  return vec4<f32>(min(c, vec3<f32>(1.0)), 1.0);
}

// Single-deck preview through the same transform the composites apply,
// minus the channel fader (mix), which would black out cued decks.
@fragment
fn fs_preview(in: VsOut) -> @location(0) vec4<f32> {
  let i = i32(uni.sel.y + 0.5);
  var d: vec4<f32>;
  switch i {
    case 0: { d = deck_color(deck0, in.uv, uni.slots[0].a.y, uni.slots[0].b.xy, uni.slots[0].fx, uni.slots[0].b.zw); }
    case 1: { d = deck_color(deck1, in.uv, uni.slots[1].a.y, uni.slots[1].b.xy, uni.slots[1].fx, uni.slots[1].b.zw); }
    case 2: { d = deck_color(deck2, in.uv, uni.slots[2].a.y, uni.slots[2].b.xy, uni.slots[2].fx, uni.slots[2].b.zw); }
    case 3: { d = deck_color(deck3, in.uv, uni.slots[3].a.y, uni.slots[3].b.xy, uni.slots[3].fx, uni.slots[3].b.zw); }
    case 4: { d = deck_color(deck4, in.uv, uni.slots[4].a.y, uni.slots[4].b.xy, uni.slots[4].fx, uni.slots[4].b.zw); }
    case 5: { d = deck_color(deck5, in.uv, uni.slots[5].a.y, uni.slots[5].b.xy, uni.slots[5].fx, uni.slots[5].b.zw); }
    case 6: { d = deck_color(deck6, in.uv, uni.slots[6].a.y, uni.slots[6].b.xy, uni.slots[6].fx, uni.slots[6].b.zw); }
    default: { d = deck_color(deck7, in.uv, uni.slots[7].a.y, uni.slots[7].b.xy, uni.slots[7].fx, uni.slots[7].b.zw); }
  }
  return vec4<f32>(d.rgb, 1.0);
}
