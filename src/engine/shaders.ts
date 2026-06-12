// Baseline shader so decks aren't black on startup; phase varies hue per
// deck. The native core has its own copy of this body (render/ingest.rs)
// for boot — this one re-stages decks on RESET and seeds getShaderBody.
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
