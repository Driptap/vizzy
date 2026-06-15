// LLM contract for procedural fly-through scenes: the model returns a strict
// JSON spec (kind + surface expression + palette) instead of GLSL; the
// expression is compiled by the lib/expr sandbox and meshed by sceneGenerator.
import { compileExpression } from '../lib/expr';
import { extractJson } from '../lib/llmJson';
import { surfaceVarsFor } from '../lib/sceneGenerator';
import type { SceneSpec } from '../types';

/** Worked few-shot scenes. Every surface here is checked to compile in the
 *  lib/expr sandbox against its kind's variables (see scenes.test.js), so the
 *  prompt can never ship an example the parser would reject. */
export interface SceneExample {
  label: string;
  spec: SceneSpec;
}

export const SCENE_EXAMPLES: SceneExample[] = [
  {
    label: 'rolling neon hills with a flight corridor',
    spec: {
      kind: 'terrain',
      surface: '(abs(sin(x*0.25 + sin(z*0.15)*0.6)) + fract(z*0.2)*0.4 + sin(x*0.8)*0.2) * min(1, abs(x)/8)',
      amplitude: 3,
      palette: ['#ff2bd1', '#15f5ff', '#0a021a'],
    },
  },
  {
    label: 'eroded canyon ridges with stepped mesas',
    spec: {
      kind: 'terrain',
      surface: 'smoothstep(0.15, 0.85, fract(x*0.12)) * (0.6 + sin(z*0.3)*0.4) * min(1, abs(x)/6)',
      amplitude: 4,
      palette: ['#ff7b00', '#ffe600', '#1a0a00'],
    },
  },
  {
    label: 'pulsing ribbed wormhole with a slow spiral',
    spec: {
      kind: 'tunnel',
      surface: 'sin(a*6)*0.3 + sin(z*0.8)*0.35 + abs(sin(a*3 + z*0.5))*0.3',
      amplitude: 3,
      palette: ['#7a00ff', '#00ffd5', '#05000f'],
    },
  },
  {
    label: 'alien dunes — domain-warped inverted ridges',
    spec: {
      kind: 'terrain',
      surface: '(1 - abs(sin(x*0.18 + sin(z*0.22)*0.8))) * (0.7 + sin(z*0.4 + x*0.1)*0.3) * min(1, abs(x)/7)',
      amplitude: 4,
      palette: ['#00e5a0', '#caff3f', '#02110c'],
    },
  },
  {
    label: 'terraced temple steps via floor quantization',
    spec: {
      kind: 'terrain',
      surface: 'floor((sin(x*0.3) + cos(z*0.25) + 2) * 1.5) / 1.5 * 0.4 * min(1, abs(x)/8)',
      amplitude: 5,
      palette: ['#ffb347', '#ff3b6b', '#160208'],
    },
  },
  {
    label: 'crystalline spikes — pow-sharpened peaks over fine grain',
    spec: {
      kind: 'terrain',
      surface: 'pow(abs(sin(x*0.6) * cos(z*0.55)), 3) * 1.5 * min(1, abs(x)/6) + fract(x*2 + z*2)*0.1',
      amplitude: 4,
      palette: ['#3f7bff', '#b3e0ff', '#02061a'],
    },
  },
  {
    label: 'organic pulsing cave — wave fed into the rib angle',
    spec: {
      kind: 'tunnel',
      surface: 'abs(sin(a*4 + sin(z*0.6)*1.2))*0.4 + sin(z*1.1)*0.25 + cos(a*8)*0.15',
      amplitude: 4,
      palette: ['#ff5e3a', '#ffd000', '#0d0300'],
    },
  },
  {
    label: 'double-helix tunnel — two counter-rotating spirals',
    spec: {
      kind: 'tunnel',
      surface: 'sin(a*2 + z*0.7)*0.4 + sin(a*2 - z*0.7)*0.4 + abs(sin(z*1.5))*0.2',
      amplitude: 3,
      palette: ['#ff2bd1', '#2bffea', '#08000d'],
    },
  },
  {
    label: 'faceted geode chambers — quantized angle facets with ringed pulses',
    spec: {
      kind: 'tunnel',
      surface: 'smoothstep(0.3, 0.7, fract(z*0.4))*0.5 + floor(mod(a, tau)/(tau/8))/8*0.4 + sin(a*16)*0.1',
      amplitude: 4,
      palette: ['#8a2be2', '#00ffc8', '#0a0014'],
    },
  },
  {
    label: 'grove of swaying palms lining a flight avenue — Gaussian spikes (trunks) tiled on a grid, columns leaning with z so they appear to dance as the camera passes; soft wide mound on top stands in for the canopy',
    spec: {
      kind: 'terrain',
      surface: '(exp(-pow(fract(x/3 - sin(z*0.6)*0.3 + 0.5) - 0.5, 2)*40) * exp(-pow(fract(z/4 + 0.5) - 0.5, 2)*40) + exp(-pow(fract(x/3 - sin(z*0.6)*0.3 + 0.5) - 0.5, 2)*7) * exp(-pow(fract(z/4 + 0.5) - 0.5, 2)*7)*0.35) * min(1, abs(x)/6)',
      amplitude: 5,
      palette: ['#0a5c2e', '#7cff5b', '#02110a'],
    },
  },
];

const renderExamples = (examples: SceneExample[]): string =>
  examples.map((ex) => `// ${ex.label}\n${JSON.stringify(ex.spec)}`).join('\n');

export const SCENE_SYSTEM_PROMPT = `You are designing a procedural 3D fly-through scene for a live VJ performance.
Respond with ONLY a single JSON object — no markdown, no explanation:
{"kind": "terrain" or "tunnel", "surface": "<math expression>", "amplitude": <number>, "palette": ["#rrggbb", "#rrggbb", "#rrggbb"]}

The camera flies forward through the scene forever.
- kind "terrain": surface is the ground height at (x, z). x spans -24..24 sideways, z runs along the flight path. Keep a low corridor near x = 0 (e.g. multiply by min(1, abs(x)/8)) so the camera has somewhere to fly. Height is clamped to 0..2 then scaled by amplitude.
- kind "tunnel": surface is the wall offset at (a, z). a is the angle around the tunnel in 0..tau, z runs along the flight path. The result is clamped to -0.8..1; positive pushes the wall outward.

surface rules:
- Use ONLY: numbers, + - * / % ^ ( ) , the variables stated above, the constants pi, tau, e, and these functions: sin cos tan abs sqrt pow min max floor ceil round fract exp log sign atan atan2 mod clamp mix step smoothstep.
- The ONLY variables are x and z (terrain) or a and z (tunnel). amplitude, palette, kind, time, t, speed, bass, and noise are NOT variables — naming any identifier outside the list above is a fatal error. amplitude scales the result automatically; never write it inside surface.
- No conditionals, no strings, no assignments, no function you were not given.

Build texture by LAYERING — add 2-4 of these terms at different frequencies and weights, no single term should dominate:
- rolling hills: sin(x*0.25 + sin(z*0.15)*0.6) — feeding one wave into another warps the grid so it never looks tiled.
- sharp ridges / mountains: abs(sin(x*f)) or 1 - abs(sin(x*f)).
- plateaus, mesas, canyon walls: smoothstep(0.2, 0.8, fract(x*f)).
- fine noise-like grain: fract(x*a + z*b) at high frequency, small weight (e.g. *0.2).
- terraces / steps: floor(h*n)/n.
For terrain, multiply the whole expression by min(1, abs(x)/8) so x≈0 stays low and flyable.
For tunnels: sin(a*N) carves N flutes around the wall; sin(z*f) makes rings or pulses down the tube; sin(a*N + z*f) spirals; abs(sin(...)) sharpens ribs.
Patterns that repeat in z every few units loop seamlessly — prefer periodic (sin/cos/fract/mod) terms in z.

amplitude: vertical relief in world units, 0.5 to 5.
palette: [base colour, peak/glow colour, fog colour]. Bold, saturated, high contrast against black.

Examples (match this density and structure; do not copy verbatim):
${renderExamples(SCENE_EXAMPLES)}`;

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
