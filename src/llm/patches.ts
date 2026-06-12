// LLM contract for deck patches: the model returns a strict JSON PatchSpec
// (generator + palette + warps + audio routing + post) instead of shader
// code. PATCH_FORMAT is a JSON schema passed to Ollama's structured-output
// `format` parameter, so decoding is constrained to the schema at the source.
import { GENERATORS, PALETTE_PRESETS, WARPS } from '../lib/patches';

const generatorCatalog = GENERATORS.map((g) => {
  const params = g.params
    .map((p) => `${p.name} ${p.min}..${p.max} (default ${p.default})`)
    .join(', ');
  return `- "${g.name}": ${g.blurb}.${params ? ` Params: ${params}.` : ''}`;
}).join('\n');

const warpCatalog = WARPS.map((w) => `- "${w.name}": ${w.blurb} (amount ${w.min}..${w.max})`).join(
  '\n',
);

export const PATCH_SYSTEM_PROMPT = `You are designing a live visual for a VJ performance. Respond with ONLY one JSON object — no markdown, no explanation — describing a patch:

{"generator": "<name>", "params": {...}, "palette": {"preset": "<name>"}, "warps": [...], "motion": {"speed": 1.0, "rotate": 0.0}, "audio": [...], "post": {...}}

generator (required) — the base visual. Pick the one that best matches the request:
${generatorCatalog}

palette — "preset" one of: ${PALETTE_PRESETS.join(', ')}. Or custom cosine coefficients {"a":[r,g,b],"b":[r,g,b],"c":[r,g,b],"d":[r,g,b]}.

warps — optional list (max 3), applied in order, each {"type", "amount", "audio"?}; "audio" (low/mid/high/level) makes the amount pulse with that band:
${warpCatalog}

motion — speed 0..4 multiplies all movement; rotate -2..2 spins the whole image.

audio — up to 3 routes {"band": low|mid|high|level, "target": scale|brightness|speed, "amount": 0..2}. Use at least one: this is a music visual.

post — optional: trail 0..0.97 (feedback persistence — the MilkDrop look), feedZoom 0.8..1.25 (1.02 = trails bloom outward), feedRotate -0.2..0.2, posterize 0..1, scanlines 0..1, grain 0..1, vignette 0..1.

Style hints: "winamp/equalizer" -> bars or fire-spectrum; "milkdrop" -> noise-flow or plasma with trail 0.9 + feedZoom 1.02; "retro/arcade" -> atari-diamonds, vhs or copper-bars with posterize + scanlines; "psychedelic/trippy" -> kaleido-mandala, julia-drift or vortex with kaleido warp; "minimal/clean" -> lissajous, scope or truchet with no post; "space" -> starfield or tunnel.

Example — "winamp style equaliser":
{"generator": "bars", "params": {"count": 32, "fill": 0.75}, "palette": {"preset": "matrix"}, "motion": {"speed": 1.0}, "audio": [{"band": "level", "target": "brightness", "amount": 0.6}], "post": {"trail": 0.6}}

Example — "hypnotic rainbow wormhole":
{"generator": "vortex", "params": {"arms": 4, "pull": 1.5}, "palette": {"preset": "rainbow"}, "warps": [{"type": "zoomPulse", "amount": 0.6, "audio": "low"}], "motion": {"speed": 1.2}, "audio": [{"band": "low", "target": "scale", "amount": 0.8}, {"band": "high", "target": "brightness", "amount": 0.5}], "post": {"trail": 0.85, "feedZoom": 1.03}}

Choose bold palettes and real audio routing. Vary your choices — don't default to the same generator every time.`;

const vec3Schema = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
};

/** JSON schema for Ollama structured outputs (`format`). */
export const PATCH_FORMAT = {
  type: 'object',
  properties: {
    generator: { type: 'string', enum: GENERATORS.map((g) => g.name) },
    params: { type: 'object', additionalProperties: { type: 'number' } },
    palette: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: [...PALETTE_PRESETS] },
        a: vec3Schema,
        b: vec3Schema,
        c: vec3Schema,
        d: vec3Schema,
      },
    },
    warps: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: WARPS.map((w) => w.name) },
          amount: { type: 'number' },
          audio: { type: 'string', enum: ['low', 'mid', 'high', 'level'] },
        },
        required: ['type'],
      },
    },
    motion: {
      type: 'object',
      properties: {
        speed: { type: 'number' },
        rotate: { type: 'number' },
      },
    },
    audio: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          band: { type: 'string', enum: ['low', 'mid', 'high', 'level'] },
          target: { type: 'string', enum: ['scale', 'brightness', 'speed'] },
          amount: { type: 'number' },
        },
        required: ['band', 'target', 'amount'],
      },
    },
    post: {
      type: 'object',
      properties: {
        trail: { type: 'number' },
        feedZoom: { type: 'number' },
        feedRotate: { type: 'number' },
        posterize: { type: 'number' },
        scanlines: { type: 'number' },
        grain: { type: 'number' },
        vignette: { type: 'number' },
      },
    },
  },
  required: ['generator'],
} as const;
