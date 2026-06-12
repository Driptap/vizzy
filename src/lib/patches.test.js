import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DECK_PATCHES,
  GENERATOR_NAMES,
  parsePatchSpec,
} from './patches';

describe('parsePatchSpec', () => {
  it('parses a complete patch', () => {
    const raw = JSON.stringify({
      generator: 'bars',
      params: { count: 32, fill: 0.7 },
      palette: { preset: 'synthwave' },
      warps: [{ type: 'mirror' }, { type: 'swirl', amount: 0.4, audio: 'low' }],
      motion: { speed: 1.2, rotate: 0.1 },
      audio: [{ band: 'low', target: 'scale', amount: 0.8 }],
      post: { trail: 0.8, feedZoom: 1.02 },
    });
    const { spec, error } = parsePatchSpec(raw);
    expect(error).toBeUndefined();
    expect(spec.generator).toBe('bars');
    expect(spec.params).toEqual({ count: 32, fill: 0.7 });
    expect(spec.warps).toHaveLength(2);
    expect(spec.post).toEqual({ trail: 0.8, feedZoom: 1.02 });
  });

  it('extracts the JSON object from prose and fences', () => {
    const raw = 'Here is your patch:\n```json\n{"generator": "tunnel"}\n```\nEnjoy!';
    expect(parsePatchSpec(raw).spec).toEqual({ generator: 'tunnel' });
  });

  it('rejects an unknown generator with the valid list as repair fuel', () => {
    const { error } = parsePatchSpec('{"generator": "disco-mode"}');
    expect(error).toContain('disco-mode');
    expect(error).toContain('plasma');
    expect(error).toContain('julia-drift');
  });

  it('rejects responses without JSON', () => {
    expect(parsePatchSpec('sorry, no').error).toBe('No JSON object found in the model response');
    expect(parsePatchSpec('{broken').error).toBe('No JSON object found in the model response');
  });

  it('drops unknown warps, bands and targets instead of failing', () => {
    const raw = JSON.stringify({
      generator: 'plasma',
      warps: [{ type: 'wormhole' }, { type: 'kaleido', amount: 6 }, 'not-an-object'],
      audio: [
        { band: 'sub-bass', target: 'scale', amount: 1 },
        { band: 'low', target: 'hue', amount: 1 },
        { band: 'mid', target: 'brightness' },
      ],
    });
    const { spec } = parsePatchSpec(raw);
    expect(spec.warps).toEqual([{ type: 'kaleido', amount: 6 }]);
    expect(spec.audio).toEqual([{ band: 'mid', target: 'brightness', amount: 0.5 }]);
  });

  it('drops non-numeric params and unknown palette presets', () => {
    const raw = JSON.stringify({
      generator: 'voronoi',
      params: { cells: 12, glow: 'lots', peakHold: true },
      palette: { preset: 'no-such-palette' },
    });
    const { spec } = parsePatchSpec(raw);
    expect(spec.params).toEqual({ cells: 12 });
    expect(spec.palette).toBeUndefined();
  });

  it('accepts custom cosine palettes', () => {
    const raw = JSON.stringify({
      generator: 'plasma',
      palette: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.33, 0.67] },
    });
    const { spec } = parsePatchSpec(raw);
    expect(spec.palette).toEqual({
      a: [0.5, 0.5, 0.5],
      b: [0.5, 0.5, 0.5],
      c: [1, 1, 1],
      d: [0, 0.33, 0.67],
    });
  });
});

describe('DEFAULT_DECK_PATCHES', () => {
  it('covers all 8 slots with valid generators', () => {
    expect(DEFAULT_DECK_PATCHES).toHaveLength(8);
    DEFAULT_DECK_PATCHES.forEach((patch) => {
      expect(GENERATOR_NAMES).toContain(patch.generator);
      // round-trips through the parser (same path a saved patch takes)
      expect(parsePatchSpec(JSON.stringify(patch)).spec).toBeTruthy();
    });
  });
});
