// Lines the engine header already provides — redeclaring them would be a
// compile error, so they're stripped from LLM output.
const RESERVED_LINE =
  /^\s*(#version|precision\s|uniform\s|varying\s|in\s+vec2\s+vUv|out\s+vec4\s)/;

const FENCE = /```(?:glsl|c\+\+|cpp|c)?\s*\n?([\s\S]*?)```/;

// First line that looks like the start of GLSL code (helpers may precede main)
const CODE_START =
  /^[ \t]*(#define|precision\s|uniform\s|const\s|(?:float|int|vec[234]|mat[234]|bool)\s+\w+|void\s+main)/m;

/**
 * Extract a compilable fragment-shader body from a raw LLM response:
 * markdown fences and conversational text are stripped, helper functions
 * above main() are kept, and everything after main's closing brace is cut.
 * Returns null if no main() block is found.
 */
export function extractShaderCode(raw) {
  if (!raw) return null;
  let text = String(raw);

  const fence = text.match(FENCE);
  if (fence) text = fence[1];

  const mainMatch = text.match(/void\s+main\s*\(\s*(?:void)?\s*\)/);
  if (!mainMatch) return null;

  const startMatch = text.match(CODE_START);
  const start = startMatch && startMatch.index <= mainMatch.index ? startMatch.index : mainMatch.index;

  const braceStart = text.indexOf('{', mainMatch.index);
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

  const code = text
    .slice(start, end + 1)
    .split('\n')
    .filter((line) => !RESERVED_LINE.test(line))
    .join('\n')
    .trim();

  return code || null;
}
