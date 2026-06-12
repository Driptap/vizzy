// Lines the engine header already provides or that ES 1.00 can't accept.
// NOTE: custom uniforms are KEPT (three leaves unbound uniforms at zero,
// which still compiles) — only redeclarations of the engine's reserved
// uniforms are stripped.
const RESERVED_LINE = /^\s*(#version\b|precision\s|varying\s|layout\b|in\s|out\s)/;
const RESERVED_UNIFORM =
  /^\s*uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+u_(?:time|resolution|audio_low|audio_mid|audio_high|audio_level)\b/;

const FENCE = /```(?:glsl|c\+\+|cpp|c)?\s*\n?([\s\S]*?)```/;

// First line that looks like the start of GLSL code (helpers may precede main)
const CODE_START =
  /^[ \t]*(#define|precision\s|uniform\s|const\s|(?:float|int|vec[234]|mat[234]|bool)\s+\w+|void\s+main)/m;

const MAIN_ENTRY = /void\s+main\s*\(\s*(?:void)?\s*\)/;
// Shadertoy-style entry point — common local-model habit; we wrap it
const SHADERTOY_ENTRY =
  /void\s+mainImage\s*\(\s*out\s+vec4\s+\w+\s*,\s*(?:in\s+)?vec2\s+\w+\s*\)/;
// GLSL3-style custom output variable, optionally layout-qualified
const OUT_VAR =
  /^\s*(?:layout\s*\([^)]*\)\s*)?out\s+(?:highp\s+|mediump\s+|lowp\s+)?vec4\s+([A-Za-z_]\w*)\s*;/m;

/**
 * Extract a compilable fragment-shader body from a raw LLM response.
 * Beyond fence/prose stripping and brace matching, this repairs the common
 * local-model dialect slips: Shadertoy mainImage entry points get wrapped,
 * custom `out vec4 X` outputs are remapped to gl_FragColor, and texture()
 * calls become texture2D(). Returns null if no entry point is found.
 */
export function extractShaderCode(raw: unknown): string | null {
  if (!raw) return null;
  let text = String(raw);

  const fence = text.match(FENCE);
  if (fence) text = fence[1];

  let entry = text.match(MAIN_ENTRY);
  let isShadertoy = false;
  if (!entry) {
    entry = text.match(SHADERTOY_ENTRY);
    isShadertoy = Boolean(entry);
  }
  if (!entry) return null;

  const entryIndex = entry.index ?? 0;
  const startMatch = text.match(CODE_START);
  const start =
    startMatch && (startMatch.index ?? 0) <= entryIndex ? (startMatch.index ?? 0) : entryIndex;

  const braceStart = text.indexOf('{', entryIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const outVar = text.match(OUT_VAR)?.[1];

  let code = text
    .slice(start, end + 1)
    .split('\n')
    .filter((line) => !RESERVED_LINE.test(line) && !RESERVED_UNIFORM.test(line))
    .join('\n');

  if (outVar && outVar !== 'gl_FragColor') {
    code = code.replace(new RegExp(`\\b${outVar}\\b`, 'g'), 'gl_FragColor');
  }
  code = code.replace(/\btexture\s*\(/g, 'texture2D(');

  if (isShadertoy) {
    code = [
      '#define iTime u_time',
      '#define iResolution vec3(u_resolution, 1.0)',
      code,
      'void main() { mainImage(gl_FragColor, vUv * u_resolution); }',
    ].join('\n');
  }

  code = code.trim();
  return code || null;
}
