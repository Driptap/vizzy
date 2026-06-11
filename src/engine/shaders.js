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

export function buildFragmentShader(body) {
  return `${FRAGMENT_HEADER}\n${body}\n`;
}

// Baseline shader so decks aren't black on startup; phase varies hue per deck.
function makeDefaultBody(phase) {
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

export const DEFAULT_DECK_BODIES = [
  makeDefaultBody(0.0),
  makeDefaultBody(1.6),
  makeDefaultBody(3.1),
  makeDefaultBody(4.7),
];

export const COMPOSITE_FRAGMENT = /* glsl */ `
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

vec2 zoomUv(vec2 uv, float s) {
  return (uv - 0.5) / max(s, 0.001) + 0.5;
}

// Each deck occupies a centered window of the canvas sized by "size"
// (fractions of canvas width/height); outside it the deck contributes
// nothing. "zoom" scales the content within that window. Alpha is treated
// as a brightness multiplier: LLMs sometimes encode the shader's shape in
// gl_FragColor.a, which would otherwise be discarded here and render as a
// solid colour wash.
vec3 deckColor(sampler2D tex, vec2 uv, float zoom, vec2 size) {
  vec2 local = (uv - 0.5) / max(size, vec2(0.001)) + 0.5;
  vec2 inside = step(vec2(0.0), local) * step(local, vec2(1.0));
  vec4 t = texture2D(tex, zoomUv(local, zoom));
  return t.rgb * t.a * inside.x * inside.y;
}

void main() {
  vec3 c = deckColor(u_deck1, vUv, u_scale1, u_size1) * u_mix1
         + deckColor(u_deck2, vUv, u_scale2, u_size2) * u_mix2
         + deckColor(u_deck3, vUv, u_scale3, u_size3) * u_mix3
         + deckColor(u_deck4, vUv, u_scale4, u_size4) * u_mix4;
  gl_FragColor = vec4(min(c, vec3(1.0)), 1.0);
}
`;
