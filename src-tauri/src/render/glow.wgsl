// Master glow (bloom) post chain, run on the offscreen master target BEFORE
// the present blit / Syphon publish / monitor encode so every consumer sees
// it: threshold-downsample to half res, separable gaussian blur (H then V,
// ping-pong), additive composite back onto the master at modest strength.
//
// Orientation: every pass here is target-row-aligned — vs_glow maps output
// row 0 to uv.y 0, so the chain is storage-orientation agnostic (the master
// is top-down; the intermediates simply inherit that).

struct GlowUniforms {
  // x, y: blur step in UV units (one texel along the blur axis)
  // z: luma threshold   w: composite strength
  params: vec4<f32>,
}

@group(0) @binding(0) var glow_samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> glow: GlowUniforms;

struct GlowVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_glow(@builtin(vertex_index) vi: u32) -> GlowVsOut {
  // one oversized triangle; uv row-aligned with the output target
  let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vi & 2u) * 2.0 - 1.0;
  var out: GlowVsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

// Keep only the energy above the luma threshold, colour-preserving.
@fragment
fn fs_threshold(in: GlowVsOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(src, glow_samp, in.uv, 0.0).rgb;
  let luma = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  let keep = max(luma - glow.params.z, 0.0) / max(luma, 1e-4);
  return vec4<f32>(c * keep, 1.0);
}

// 9-tap separable gaussian along params.xy.
@fragment
fn fs_blur(in: GlowVsOut) -> @location(0) vec4<f32> {
  let d = glow.params.xy;
  var w = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var acc = textureSampleLevel(src, glow_samp, in.uv, 0.0).rgb * w[0];
  for (var i = 1; i < 5; i = i + 1) {
    let off = d * f32(i);
    acc += textureSampleLevel(src, glow_samp, in.uv + off, 0.0).rgb * w[i];
    acc += textureSampleLevel(src, glow_samp, in.uv - off, 0.0).rgb * w[i];
  }
  return vec4<f32>(acc, 1.0);
}

// Additive composite (pipeline blend ONE + ONE) of the blurred highlights.
@fragment
fn fs_composite(in: GlowVsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSampleLevel(src, glow_samp, in.uv, 0.0).rgb * glow.params.w, 0.0);
}
