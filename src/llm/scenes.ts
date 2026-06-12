// LLM contract for procedural fly-through scenes: the model returns a strict
// JSON spec (kind + surface expression + palette) instead of GLSL; the
// expression is compiled by the lib/expr sandbox and meshed by sceneGenerator.
import { compileExpression } from '../lib/expr';
import { extractJson } from '../lib/llmJson';
import { surfaceVarsFor } from '../lib/sceneGenerator';
import type { SceneSpec } from '../types';

export const SCENE_SYSTEM_PROMPT = `You are designing a procedural 3D fly-through scene for a live VJ performance.
Respond with ONLY a single JSON object — no markdown, no explanation:
{"kind": "terrain" or "tunnel", "surface": "<math expression>", "amplitude": <number>, "palette": ["#rrggbb", "#rrggbb", "#rrggbb"]}

The camera flies forward through the scene forever.
- kind "terrain": surface is the ground height at (x, z). x spans -24..24 sideways, z runs along the flight path. Keep a low corridor near x = 0 (e.g. multiply by min(1, abs(x)/8)) so the camera has somewhere to fly. Height is clamped to 0..2 then scaled by amplitude.
- kind "tunnel": surface is the wall offset at (a, z). a is the angle around the tunnel in 0..tau, z runs along the flight path. The result is clamped to -0.8..1; positive pushes the wall outward.

surface rules:
- Use ONLY: numbers, + - * / % ^ ( ) , the variables stated above, the constants pi, tau, e, and these functions: sin cos tan abs sqrt pow min max floor ceil round fract exp log sign atan atan2 mod clamp mix step smoothstep.
- No other identifiers exist. No conditionals, no strings, no assignments.
- Layer 2-4 sine/fract terms at different frequencies for organic detail. Patterns repeating in z every few units loop best.

amplitude: vertical relief in world units, 0.5 to 5.
palette: [base colour, peak/glow colour, fog colour]. Bold, saturated, high contrast against black.`;

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_PALETTE: SceneSpec['palette'] = ['#ff71ce', '#01cdfe', '#1a0533'];

export type SceneParseResult = { spec: SceneSpec; error?: undefined } | { spec?: undefined; error: string };

/**
 * Parse + validate a raw model response into a SceneSpec. The surface
 * expression must compile in the sandbox with the kind's variables; palette
 * entries fall back rather than fail, amplitude is clamped to sane bounds.
 */
export function parseSceneSpec(raw: unknown): SceneParseResult {
  const json = extractJson(String(raw ?? ''));
  if (!json) return { error: 'No JSON object found in the model response' };

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json);
  } catch {
    return { error: 'The model response is not valid JSON' };
  }

  const kind = data.kind === 'tunnel' ? 'tunnel' : data.kind === 'terrain' ? 'terrain' : null;
  if (!kind) return { error: `Scene kind must be "terrain" or "tunnel", got ${JSON.stringify(data.kind)}` };

  const surface = typeof data.surface === 'string' ? data.surface.trim() : '';
  if (!surface) return { error: 'Missing "surface" expression' };
  try {
    compileExpression(surface, surfaceVarsFor(kind));
  } catch (err) {
    return { error: `Bad surface expression: ${(err as Error).message}` };
  }

  const rawAmplitude = Number(data.amplitude);
  const amplitude = Number.isFinite(rawAmplitude)
    ? Math.min(5, Math.max(0.5, rawAmplitude))
    : 2;

  const rawPalette = Array.isArray(data.palette) ? data.palette : [];
  const palette = DEFAULT_PALETTE.map((fallback, i) => {
    const value = rawPalette[i];
    return typeof value === 'string' && HEX.test(value.trim()) ? value.trim() : fallback;
  }) as SceneSpec['palette'];

  return { spec: { kind, surface, amplitude, palette } };
}
