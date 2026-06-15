// The patch catalog and validator: the TS mirror of the Rust composer's
// registries (src-tauri/src/render/patch.rs). The catalog metadata feeds the
// LLM system prompt; parsePatchSpec normalizes raw model output into a spec
// that always renders (the Rust side clamps values again, defensively).
import { extractJson } from './llmJson';
import type { AudioBand, PatchAudioRoute, PatchPalette, PatchSpec, PatchWarp } from '../types';

export interface GeneratorParamInfo {
  name: string;
  default: number;
  min: number;
  max: number;
}

export interface GeneratorInfo {
  name: string;
  /** one vivid line for the LLM catalog */
  blurb: string;
  params: GeneratorParamInfo[];
}

const gp = (name: string, def: number, min: number, max: number): GeneratorParamInfo => ({
  name,
  default: def,
  min,
  max,
});

export const GENERATORS: GeneratorInfo[] = [
  { name: 'bars', blurb: 'vertical spectrum bars with peak caps — the classic Winamp equalizer look', params: [gp('count', 24, 4, 64), gp('fill', 0.8, 0.3, 1), gp('cap', 1, 0, 1)] },
  { name: 'radial-spectrum', blurb: 'spectrum bars bent around a circle, a pulsing audio mandala-meter', params: [gp('count', 32, 8, 64), gp('inner', 0.25, 0.05, 0.6)] },
  { name: 'scope', blurb: 'oscilloscope waveform traces snaking across the screen', params: [gp('traces', 3, 1, 5), gp('amp', 0.35, 0.1, 0.8)] },
  { name: 'lissajous', blurb: 'glowing XY-scope curve looping on the bass', params: [gp('fx', 3, 1, 8), gp('fy', 2, 1, 8), gp('glow', 1, 0.3, 3)] },
  { name: 'vu-needles', blurb: 'big analog VU meters with swinging needles', params: [gp('needles', 2, 1, 4)] },
  { name: 'fire-spectrum', blurb: 'spectrum bars burning as rising flames', params: [gp('cols', 28, 8, 64)] },
  { name: 'tunnel', blurb: 'flying forward through a ringed, spoked tunnel', params: [gp('rings', 8, 2, 24), gp('spokes', 8, 0, 24), gp('twist', 0.3, 0, 2)] },
  { name: 'starfield', blurb: 'hyperspace starfield rushing past', params: [gp('layers', 3, 1, 5), gp('density', 1, 0.3, 3)] },
  { name: 'vortex', blurb: 'twisting wormhole spiral pulling inward', params: [gp('arms', 3, 1, 8), gp('pull', 1, 0.2, 3)] },
  { name: 'synthwave-grid', blurb: 'outrun horizon: perspective grid below, sliced sun above', params: [gp('gridScale', 8, 4, 20), gp('sun', 1, 0, 1)] },
  { name: 'plasma', blurb: 'layered sine plasma, the timeless demoscene swirl', params: [gp('freq', 3, 1, 8)] },
  { name: 'copper-bars', blurb: 'glossy Amiga raster bars bouncing in colour', params: [gp('bars', 7, 3, 16), gp('gloss', 1, 0.2, 2)] },
  { name: 'interference', blurb: 'moiré ring interference from drifting wave emitters', params: [gp('sources', 3, 2, 5), gp('freq', 24, 8, 60)] },
  { name: 'noise-flow', blurb: 'domain-warped flowing noise, liquid smoke-like colour fields', params: [gp('zoom', 2.5, 1, 6), gp('warp', 1.5, 0, 3)] },
  { name: 'metaballs', blurb: 'lava-lamp blobs merging and splitting', params: [gp('blobs', 6, 3, 10), gp('size', 1, 0.4, 2)] },
  { name: 'caustics', blurb: 'underwater light webs rippling like a pool floor', params: [gp('scale', 6, 2, 12)] },
  { name: 'kaleido-mandala', blurb: 'folded sacred-geometry mandala of petals and rings', params: [gp('petals', 8, 3, 24), gp('rings', 6, 2, 16)] },
  { name: 'voronoi', blurb: 'stained-glass cells lighting up with the music', params: [gp('cells', 8, 3, 20)] },
  { name: 'truchet', blurb: 'self-connecting tile maze of glowing arcs', params: [gp('tiles', 10, 4, 24), gp('width', 0.08, 0.02, 0.2)] },
  { name: 'hex-pulse', blurb: 'hexagon grid with rings rippling outward from beats', params: [gp('cells', 8, 3, 18)] },
  { name: 'spirograph', blurb: 'hypnotic spirograph curve tracing neon geometry', params: [gp('a', 5, 1, 12), gp('b', 3, 1, 12), gp('d', 0.6, 0.2, 1.5)] },
  { name: 'julia-drift', blurb: 'Julia-set fractal with its seed orbiting on the audio', params: [gp('zoom', 1.4, 0.6, 3), gp('drift', 0.5, 0.1, 1.5)] },
  { name: 'kali-ifs', blurb: 'kaliset fractal folds, intricate alien filigree', params: [gp('fold', 1.1, 0.6, 1.8)] },
  { name: 'matrix-rain', blurb: 'falling glyph columns, the digital rain', params: [gp('columns', 36, 12, 80)] },
  { name: 'atari-diamonds', blurb: 'expanding concentric diamonds, Atari Video Music style', params: [gp('rings', 10, 3, 24)] },
  { name: 'rutt-etra', blurb: 'horizontal scanlines displaced by a luma field — the Bowie "Heroes" video-synth look', params: [gp('lines', 56, 20, 120), gp('depth', 0.25, 0.05, 0.6)] },
  { name: 'vhs', blurb: 'analog VHS: colour bars, tracking glitches, static', params: [gp('noise', 0.5, 0, 1)] },
];

export const GENERATOR_NAMES = GENERATORS.map((g) => g.name);

export interface WarpInfo {
  name: string;
  blurb: string;
  min: number;
  max: number;
}

export const WARPS: WarpInfo[] = [
  { name: 'mirror', blurb: 'mirror the left half onto the right', min: 0, max: 1 },
  { name: 'kaleido', blurb: 'fold into N symmetric sectors (amount = sector count)', min: 2, max: 24 },
  { name: 'swirl', blurb: 'twist space around the centre', min: -3, max: 3 },
  { name: 'fisheye', blurb: 'barrel-bulge or pinch the view', min: -1, max: 2 },
  { name: 'ripple', blurb: 'concentric water ripples', min: 0, max: 2 },
  { name: 'zoomPulse', blurb: 'rhythmic zoom in and out', min: 0, max: 2 },
  { name: 'scroll', blurb: 'scroll sideways forever', min: -4, max: 4 },
  { name: 'polar', blurb: 'wrap the image into polar coordinates', min: 0, max: 1 },
  { name: 'tile', blurb: 'repeat as an N×N grid', min: 1, max: 8 },
  { name: 'pixelate', blurb: 'chunky mosaic pixels', min: 0, max: 1 },
  { name: 'shear', blurb: 'wobbling horizontal shear', min: 0, max: 2 },
];

export const WARP_NAMES = WARPS.map((w) => w.name);

export const PALETTE_PRESETS = [
  'rainbow',
  'synthwave',
  'fire',
  'ice',
  'matrix',
  'miami',
  'acid',
  'vapor',
  'lasergrid',
  'mono-amber',
] as const;

const AUDIO_BANDS: AudioBand[] = ['low', 'mid', 'high', 'level', 'beat'];
const AUDIO_TARGETS = ['scale', 'brightness', 'speed'] as const;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const vec3 = (v: unknown): [number, number, number] | undefined => {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const [a, b, c] = [num(v[0]), num(v[1]), num(v[2])];
  return a !== undefined && b !== undefined && c !== undefined ? [a, b, c] : undefined;
};

function normalizePalette(raw: unknown): PatchPalette | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.preset === 'string') {
    const preset = p.preset.trim();
    return (PALETTE_PRESETS as readonly string[]).includes(preset) ? { preset } : undefined;
  }
  const [a, b, c, d] = [vec3(p.a), vec3(p.b), vec3(p.c), vec3(p.d)];
  return a && b && c && d ? { a, b, c, d } : undefined;
}

function normalizeWarps(raw: unknown): PatchWarp[] {
  if (!Array.isArray(raw)) return [];
  const warps: PatchWarp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    if (typeof w.type !== 'string' || !WARP_NAMES.includes(w.type)) continue;
    const warp: PatchWarp = { type: w.type };
    const amount = num(w.amount);
    if (amount !== undefined) warp.amount = amount;
    if (typeof w.audio === 'string' && AUDIO_BANDS.includes(w.audio as AudioBand)) {
      warp.audio = w.audio as AudioBand;
    }
    warps.push(warp);
    if (warps.length === 4) break;
  }
  return warps;
}

function normalizeRoutes(raw: unknown): PatchAudioRoute[] {
  if (!Array.isArray(raw)) return [];
  const routes: PatchAudioRoute[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.band !== 'string' || !AUDIO_BANDS.includes(r.band as AudioBand)) continue;
    if (
      typeof r.target !== 'string' ||
      !(AUDIO_TARGETS as readonly string[]).includes(r.target)
    ) {
      continue;
    }
    routes.push({
      band: r.band as AudioBand,
      target: r.target as PatchAudioRoute['target'],
      amount: num(r.amount) ?? 0.5,
    });
    if (routes.length === 3) break;
  }
  return routes;
}

const POST_KEYS = [
  'trail',
  'feedZoom',
  'feedRotate',
  'posterize',
  'scanlines',
  'grain',
  'vignette',
] as const;

export type PatchParseResult =
  | { spec: PatchSpec; error?: undefined }
  | { spec?: undefined; error: string };

/**
 * Parse + normalize a raw model response into a PatchSpec. Per-field fallback
 * everywhere except the generator itself: an unknown generator is the one
 * mistake worth bouncing back to the model, with the valid list as repair
 * fuel. Everything that survives this function renders.
 */
export function parsePatchSpec(raw: unknown): PatchParseResult {
  const json = extractJson(String(raw ?? ''));
  if (!json) return { error: 'No JSON object found in the model response' };

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json);
  } catch {
    return { error: 'The model response is not valid JSON' };
  }

  const generator = typeof data.generator === 'string' ? data.generator.trim() : '';
  if (!GENERATOR_NAMES.includes(generator)) {
    return {
      error: `Unknown generator ${JSON.stringify(data.generator)}. Pick one of: ${GENERATOR_NAMES.join(', ')}`,
    };
  }

  const spec: PatchSpec = { generator };

  if (data.params && typeof data.params === 'object') {
    const params: Record<string, number> = {};
    for (const [key, value] of Object.entries(data.params as Record<string, unknown>)) {
      const v = num(value);
      if (v !== undefined) params[key] = v;
    }
    if (Object.keys(params).length) spec.params = params;
  }

  const palette = normalizePalette(data.palette);
  if (palette) spec.palette = palette;

  const warps = normalizeWarps(data.warps);
  if (warps.length) spec.warps = warps;

  if (data.motion && typeof data.motion === 'object') {
    const m = data.motion as Record<string, unknown>;
    const motion: { speed?: number; rotate?: number } = {};
    const speed = num(m.speed);
    const rotate = num(m.rotate);
    if (speed !== undefined) motion.speed = speed;
    if (rotate !== undefined) motion.rotate = rotate;
    if (Object.keys(motion).length) spec.motion = motion;
  }

  const audio = normalizeRoutes(data.audio);
  if (audio.length) spec.audio = audio;

  if (data.post && typeof data.post === 'object') {
    const p = data.post as Record<string, unknown>;
    const post: Record<string, number> = {};
    for (const key of POST_KEYS) {
      const v = num(p[key]);
      if (v !== undefined) post[key] = v;
    }
    if (Object.keys(post).length) spec.post = post;
  }

  return { spec };
}

/**
 * Boot/RESET patches, one per slot — mirrors default_patch() in
 * src-tauri/src/render/patch.rs so RESET restores exactly the boot rig.
 */
export const DEFAULT_DECK_PATCHES: PatchSpec[] = [
  { generator: 'plasma', palette: { preset: 'rainbow' }, audio: [{ band: 'level', target: 'brightness', amount: 0.6 }] },
  { generator: 'tunnel', palette: { preset: 'synthwave' }, audio: [{ band: 'low', target: 'speed', amount: 0.5 }] },
  { generator: 'bars', palette: { preset: 'miami' } },
  { generator: 'noise-flow', palette: { preset: 'vapor' }, audio: [{ band: 'level', target: 'brightness', amount: 0.5 }] },
  { generator: 'starfield', palette: { preset: 'ice' }, audio: [{ band: 'high', target: 'brightness', amount: 0.6 }] },
  { generator: 'kaleido-mandala', palette: { preset: 'lasergrid' }, audio: [{ band: 'low', target: 'scale', amount: 0.4 }] },
  { generator: 'metaballs', palette: { preset: 'fire' } },
  { generator: 'interference', palette: { preset: 'acid' }, audio: [{ band: 'mid', target: 'brightness', amount: 0.5 }] },
];
