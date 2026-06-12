export const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

// Every generated shader gets this header prepended — the LLM is told these
// uniforms exist and must not redeclare them (the parser strips redeclarations).
export const FRAGMENT_HEADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_audio_low;
uniform float u_audio_mid;
uniform float u_audio_high;
uniform float u_audio_level;
`;

export function buildFragmentShader(body: string): string {
  return `${FRAGMENT_HEADER}\n${body}\n`;
}

// Baseline shader so decks aren't black on startup; phase varies hue per deck.
function makeDefaultBody(phase: number): string {
  return /* glsl */ `
void main() {
  vec2 uv = vUv;
  float pulse = 0.55 + 0.45 * sin(u_time * 1.5 + ${phase.toFixed(1)});
  vec3 base = 0.5 + 0.5 * cos(u_time * 0.4 + uv.xyx * 3.0 + vec3(${phase.toFixed(1)}, ${(phase + 2.0).toFixed(1)}, ${(phase + 4.0).toFixed(1)}));
  float glow = smoothstep(0.95, 0.15, distance(uv, vec2(0.5)));
  vec3 col = base * (0.2 + 0.8 * pulse) * glow;
  col += vec3(u_audio_low, u_audio_mid, u_audio_high) * 0.45 * glow;
  col += u_audio_level * 0.1;
  gl_FragColor = vec4(col, 1.0);
}
`;
}

// 8 slots: scene A channels 1-4, scene B channels 5-8
export const DEFAULT_DECK_BODIES = [0.0, 1.6, 3.1, 4.7, 0.8, 2.4, 3.9, 5.5].map(
  makeDefaultBody,
);

// Shared per-deck sampling: each deck occupies a centered window of the
// canvas sized by "size" (fractions of canvas width/height); outside it the
// deck contributes nothing. "zoom" scales the content within that window.
// Alpha is treated as a brightness multiplier: LLMs sometimes encode the
// shader's shape in gl_FragColor.a, which would otherwise be discarded and
// render as a solid colour wash.
const DECK_SAMPLING = /* glsl */ `
uniform float u_aspect;
uniform float u_time;

vec2 zoomUv(vec2 uv, float s) {
  return (uv - 0.5) / max(s, 0.001) + 0.5;
}

// fx packs the per-channel post ops: x = tilt (radians), y = contrast,
// z = hue rotation (radians), w = saturation. The tilt rotates the content
// inside its axis-aligned window, aspect-corrected so it spins instead of
// shearing; hue rotates RGB about the grey axis (Rodrigues).
// warp carries the engine-driven AUT effects for shader decks: x = sine UV
// distortion, y = shear — both zero when idle, so the fast path is unchanged.
// Returns premultiplied colour in rgb and COVERAGE in a (texture alpha masked
// by the channel window) — coverage feeds the layer compositor below.
vec4 deckColor(sampler2D tex, vec2 uv, float zoom, vec2 size, vec4 fx, vec2 warp) {
  vec2 local = (uv - 0.5) / max(size, vec2(0.001)) + 0.5;
  vec2 inside = step(vec2(0.0), local) * step(local, vec2(1.0));
  float tc = cos(fx.x);
  float ts = sin(fx.x);
  vec2 q = (local - 0.5) * vec2(u_aspect, 1.0);
  q = mat2(tc, -ts, ts, tc) * q;
  local = q / vec2(u_aspect, 1.0) + 0.5;
  local.x += warp.y * (local.y - 0.5);
  local += warp.x * 0.06 * vec2(
    sin(local.y * 12.0 + u_time * 5.0),
    sin(local.x * 10.0 + u_time * 4.0)
  );
  vec4 t = texture2D(tex, zoomUv(local, zoom));
  vec3 col = t.rgb * t.a;
  col = (col - 0.5) * fx.y + 0.5;
  float hc = cos(fx.z);
  float hs = sin(fx.z);
  vec3 k = vec3(0.57735);
  col = col * hc + cross(k, col) * hs + k * dot(k, col) * (1.0 - hc);
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, fx.w);
  float mask = inside.x * inside.y;
  return vec4(max(col, vec3(0.0)) * mask, t.a * mask);
}

// Layer compositor for one scene's 4 decks (already faded by their mixes).
// Layers stack 4 (base) up to 1 (top): decks SHARING a layer sum additively
// (the classic mixer behaviour), each higher layer sits OVER the result
// using its coverage — an image's transparency cuts out what's beneath.
vec3 layerStack(vec4 d1, vec4 d2, vec4 d3, vec4 d4, float l1, float l2, float l3, float l4) {
  vec3 acc = vec3(0.0);
  for (int L = 4; L >= 1; L -= 1) {
    float fL = float(L);
    float on1 = step(abs(l1 - fL), 0.5);
    float on2 = step(abs(l2 - fL), 0.5);
    float on3 = step(abs(l3 - fL), 0.5);
    float on4 = step(abs(l4 - fL), 0.5);
    vec3 col = d1.rgb * on1 + d2.rgb * on2 + d3.rgb * on3 + d4.rgb * on4;
    float cov = min(1.0, d1.a * on1 + d2.a * on2 + d3.a * on3 + d4.a * on4);
    acc = col + acc * (1.0 - cov);
  }
  return acc;
}
`;

// Sprite quad: unlike the fullscreen-quad shaders this one respects the mesh
// transform (scale/rotation/position drive the layout). Distortion is a UV
// sine wobble, skew a UV shear; samples pushed outside the texture go
// transparent instead of streaking.
export const SPRITE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SPRITE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_map;
uniform float u_opacity;
uniform float u_distort;
uniform float u_skew;
uniform float u_time;
void main() {
  vec2 uv = vUv;
  uv.x += u_skew * (uv.y - 0.5);
  uv += u_distort * 0.08 * vec2(
    sin(uv.y * 12.0 + u_time * 5.0),
    sin(uv.x * 10.0 + u_time * 4.0)
  );
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  vec4 t = texture2D(u_map, uv);
  gl_FragColor = vec4(t.rgb, t.a * u_opacity * inside.x * inside.y);
}
`;

// Single-deck preview: the deck texture through the SAME transform the
// composites apply (zoom, footprint window, alpha-as-brightness) so the
// thumbnail shows what the deck will contribute to the final output —
// minus the channel fader/mute, which would black out cued decks.
export const PREVIEW_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_tex;
uniform float u_scale;
uniform vec2 u_size;
uniform vec4 u_fx;
uniform vec2 u_warp;
${DECK_SAMPLING}
void main() {
  gl_FragColor = vec4(deckColor(u_tex, vUv, u_scale, u_size, u_fx, u_warp).rgb, 1.0);
}
`;

// One scene: additive mix of its 4 decks (used for the A and B side views)
export const SCENE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_deck1;
uniform sampler2D u_deck2;
uniform sampler2D u_deck3;
uniform sampler2D u_deck4;
uniform float u_mix1;
uniform float u_mix2;
uniform float u_mix3;
uniform float u_mix4;
uniform float u_scale1;
uniform float u_scale2;
uniform float u_scale3;
uniform float u_scale4;
uniform vec2 u_size1;
uniform vec2 u_size2;
uniform vec2 u_size3;
uniform vec2 u_size4;
uniform vec4 u_fx1;
uniform vec4 u_fx2;
uniform vec4 u_fx3;
uniform vec4 u_fx4;
uniform vec2 u_warp1;
uniform vec2 u_warp2;
uniform vec2 u_warp3;
uniform vec2 u_warp4;
uniform float u_layer1;
uniform float u_layer2;
uniform float u_layer3;
uniform float u_layer4;
${DECK_SAMPLING}
void main() {
  vec4 d1 = deckColor(u_deck1, vUv, u_scale1, u_size1, u_fx1, u_warp1) * u_mix1;
  vec4 d2 = deckColor(u_deck2, vUv, u_scale2, u_size2, u_fx2, u_warp2) * u_mix2;
  vec4 d3 = deckColor(u_deck3, vUv, u_scale3, u_size3, u_fx3, u_warp3) * u_mix3;
  vec4 d4 = deckColor(u_deck4, vUv, u_scale4, u_size4, u_fx4, u_warp4) * u_mix4;
  vec3 c = layerStack(d1, d2, d3, d4, u_layer1, u_layer2, u_layer3, u_layer4);
  gl_FragColor = vec4(min(c, vec3(1.0)), 1.0);
}
`;

export const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D u_deck1;
uniform sampler2D u_deck2;
uniform sampler2D u_deck3;
uniform sampler2D u_deck4;
uniform sampler2D u_deck5;
uniform sampler2D u_deck6;
uniform sampler2D u_deck7;
uniform sampler2D u_deck8;
uniform float u_mix1;
uniform float u_mix2;
uniform float u_mix3;
uniform float u_mix4;
uniform float u_mix5;
uniform float u_mix6;
uniform float u_mix7;
uniform float u_mix8;
uniform float u_scale1;
uniform float u_scale2;
uniform float u_scale3;
uniform float u_scale4;
uniform float u_scale5;
uniform float u_scale6;
uniform float u_scale7;
uniform float u_scale8;
uniform vec2 u_size1;
uniform vec2 u_size2;
uniform vec2 u_size3;
uniform vec2 u_size4;
uniform vec2 u_size5;
uniform vec2 u_size6;
uniform vec2 u_size7;
uniform vec2 u_size8;
uniform vec4 u_fx1;
uniform vec4 u_fx2;
uniform vec4 u_fx3;
uniform vec4 u_fx4;
uniform vec4 u_fx5;
uniform vec4 u_fx6;
uniform vec4 u_fx7;
uniform vec4 u_fx8;
uniform vec2 u_warp1;
uniform vec2 u_warp2;
uniform vec2 u_warp3;
uniform vec2 u_warp4;
uniform vec2 u_warp5;
uniform vec2 u_warp6;
uniform vec2 u_warp7;
uniform vec2 u_warp8;
uniform float u_layer1;
uniform float u_layer2;
uniform float u_layer3;
uniform float u_layer4;
uniform float u_layer5;
uniform float u_layer6;
uniform float u_layer7;
uniform float u_layer8;
uniform float u_xfade; // 0.0 = scene A (decks 1-4), 1.0 = scene B (decks 5-8)
${DECK_SAMPLING}
void main() {
  vec4 d1 = deckColor(u_deck1, vUv, u_scale1, u_size1, u_fx1, u_warp1) * u_mix1;
  vec4 d2 = deckColor(u_deck2, vUv, u_scale2, u_size2, u_fx2, u_warp2) * u_mix2;
  vec4 d3 = deckColor(u_deck3, vUv, u_scale3, u_size3, u_fx3, u_warp3) * u_mix3;
  vec4 d4 = deckColor(u_deck4, vUv, u_scale4, u_size4, u_fx4, u_warp4) * u_mix4;
  vec4 d5 = deckColor(u_deck5, vUv, u_scale5, u_size5, u_fx5, u_warp5) * u_mix5;
  vec4 d6 = deckColor(u_deck6, vUv, u_scale6, u_size6, u_fx6, u_warp6) * u_mix6;
  vec4 d7 = deckColor(u_deck7, vUv, u_scale7, u_size7, u_fx7, u_warp7) * u_mix7;
  vec4 d8 = deckColor(u_deck8, vUv, u_scale8, u_size8, u_fx8, u_warp8) * u_mix8;
  vec3 a = layerStack(d1, d2, d3, d4, u_layer1, u_layer2, u_layer3, u_layer4);
  vec3 b = layerStack(d5, d6, d7, d8, u_layer5, u_layer6, u_layer7, u_layer8);
  vec3 c = a * (1.0 - u_xfade) + b * u_xfade;
  gl_FragColor = vec4(min(c, vec3(1.0)), 1.0);
}
`;
