import { describe, it, expect } from 'vitest';
import { extractShaderCode } from './parser';

const MAIN = `void main() {
  gl_FragColor = vec4(1.0);
}`;

describe('extractShaderCode', () => {
  it('returns null for empty input', () => {
    expect(extractShaderCode(null)).toBeNull();
    expect(extractShaderCode(undefined)).toBeNull();
    expect(extractShaderCode('')).toBeNull();
  });

  it('returns null when there is no entry point', () => {
    expect(extractShaderCode('here is some prose about shaders')).toBeNull();
    expect(extractShaderCode('float helper(float x) { return x; }')).toBeNull();
  });

  it('returns null when the main block never closes', () => {
    expect(extractShaderCode('void main() { gl_FragColor = vec4(1.0);')).toBeNull();
  });

  it('extracts a bare main block', () => {
    expect(extractShaderCode(MAIN)).toBe(MAIN);
  });

  it('accepts void main(void)', () => {
    const code = 'void main(void) { gl_FragColor = vec4(1.0); }';
    expect(extractShaderCode(code)).toBe(code);
  });

  it('strips surrounding prose', () => {
    const raw = `Sure! Here is your shader:\n${MAIN}\nHope you like it!`;
    expect(extractShaderCode(raw)).toBe(MAIN);
  });

  it('extracts from a fenced code block', () => {
    expect(extractShaderCode(`Here you go:\n\`\`\`glsl\n${MAIN}\n\`\`\`\nEnjoy!`)).toBe(MAIN);
  });

  it.each(['', 'glsl', 'c++', 'cpp', 'c'])('accepts a ```%s fence tag', (tag) => {
    expect(extractShaderCode(`\`\`\`${tag}\n${MAIN}\n\`\`\``)).toBe(MAIN);
  });

  it('keeps helper functions, defines and consts above main', () => {
    const raw = `Some intro text.
#define TAU 6.2831
const float K = 2.0;
float wave(float x) { return sin(x * TAU) * K; }
void main() {
  gl_FragColor = vec4(wave(vUv.x));
}`;
    const code = extractShaderCode(raw);
    expect(code).toContain('#define TAU');
    expect(code).toContain('const float K');
    expect(code).toContain('float wave(float x)');
    expect(code).toContain('void main()');
    expect(code).not.toContain('Some intro text');
  });

  it('handles nested braces inside main', () => {
    const raw = `void main() {
  for (int i = 0; i < 4; i++) {
    if (vUv.x > 0.5) { gl_FragColor = vec4(1.0); }
  }
}
Trailing explanation that should be dropped.`;
    const code = extractShaderCode(raw);
    expect(code.endsWith('}')).toBe(true);
    expect(code).not.toContain('Trailing explanation');
  });

  it('strips redeclarations of engine-reserved uniforms', () => {
    const raw = `uniform float u_time;
uniform vec2 u_resolution;
uniform highp float u_audio_low;
${MAIN}`;
    const code = extractShaderCode(raw);
    expect(code).not.toContain('u_time;');
    expect(code).not.toContain('u_resolution;');
    expect(code).not.toContain('u_audio_low;');
  });

  it('keeps custom (non-reserved) uniforms', () => {
    const raw = `uniform float u_custom_speed;\n${MAIN}`;
    expect(extractShaderCode(raw)).toContain('uniform float u_custom_speed;');
  });

  it('strips precision, varying and #version lines', () => {
    const raw = `#version 300 es
precision highp float;
varying vec2 vUv;
${MAIN}`;
    const code = extractShaderCode(raw);
    expect(code).not.toContain('#version');
    expect(code).not.toContain('precision');
    expect(code).not.toContain('varying');
  });

  it('remaps a custom out variable to gl_FragColor', () => {
    const raw = `out vec4 fragColor;
void main() {
  fragColor = vec4(1.0);
}`;
    const code = extractShaderCode(raw);
    expect(code).toContain('gl_FragColor = vec4(1.0);');
    expect(code).not.toContain('fragColor');
  });

  it('remaps a layout-qualified out variable', () => {
    const raw = `layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(0.5);
}`;
    const code = extractShaderCode(raw);
    expect(code).toContain('gl_FragColor = vec4(0.5);');
  });

  it('rewrites texture() calls to texture2D()', () => {
    const raw = `void main() {
  gl_FragColor = texture (u_map, vUv) + texture(u_map, vUv * 2.0);
}`;
    const code = extractShaderCode(raw);
    expect(code).toContain('texture2D(u_map, vUv)');
    expect(code).toContain('texture2D(u_map, vUv * 2.0)');
    expect(code).not.toMatch(/texture\s*\(/);
  });

  it('does not rewrite texture2D() twice', () => {
    const raw = `void main() { gl_FragColor = texture2D(u_map, vUv); }`;
    expect(extractShaderCode(raw)).toContain('texture2D(u_map, vUv)');
    expect(extractShaderCode(raw)).not.toContain('texture2D2D');
  });

  it('wraps a Shadertoy mainImage entry point', () => {
    const raw = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}`;
    const code = extractShaderCode(raw);
    expect(code).toContain('#define iTime u_time');
    expect(code).toContain('#define iResolution vec3(u_resolution, 1.0)');
    expect(code).toContain('void mainImage(');
    expect(code).toContain('void main() { mainImage(gl_FragColor, vUv * u_resolution); }');
  });

  it('accepts mainImage without the "in" qualifier', () => {
    const raw = `void mainImage(out vec4 O, vec2 U) { O = vec4(1.0); }`;
    expect(extractShaderCode(raw)).toContain('void main() { mainImage(');
  });

  it('prefers main over mainImage when both exist', () => {
    const raw = `void mainImage(out vec4 c, in vec2 p) { c = vec4(0.0); }
void main() { mainImage(gl_FragColor, vUv); }`;
    const code = extractShaderCode(raw);
    // no Shadertoy wrapper added — the response already has a real main
    expect(code).not.toContain('#define iTime');
  });

  it('trims the result', () => {
    const code = extractShaderCode(`\n\n${MAIN}\n\n`);
    expect(code).toBe(code.trim());
  });
});
