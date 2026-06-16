import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./shaderLibrary', () => {
  let n = 0;
  return {
    saveShader: vi.fn(async (data) => ({ id: `shader-${++n}`, createdAt: n, ...data })),
    saveScene: vi.fn(async (data) => ({ id: `scene-${++n}`, kind: 'scene', createdAt: n, ...data })),
    saveDeck: vi.fn(async (data) => ({ id: `deck-${++n}`, kind: 'deck', createdAt: n, ...data })),
    saveAssetFromBuffer: vi.fn(async ({ kind, ...data }) => ({
      id: `${kind}-${++n}`,
      kind,
      createdAt: n,
      ...data,
    })),
    deleteEntry: vi.fn(async () => {}),
  };
});

import { dedupeExampleEntries, seedExampleLibrary, EXAMPLE_DECK_NAME } from './exampleSeed';
import { saveShader, saveScene, saveDeck, saveAssetFromBuffer, deleteEntry } from './shaderLibrary';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dedupeExampleEntries', () => {
  const entry = (id, name) => ({ id, name });

  it('leaves a list without duplicates untouched (no deletes issued)', async () => {
    const entries = [entry('1', EXAMPLE_DECK_NAME), entry('2', 'Example · Torus'), entry('3', 'Mine')];
    expect(await dedupeExampleEntries(entries)).toBe(entries);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it('keeps the first (newest) of each example name and deletes the rest', async () => {
    const keepDeck = entry('new-deck', EXAMPLE_DECK_NAME);
    const oldDeck = entry('old-deck', EXAMPLE_DECK_NAME);
    const olderDeck = entry('older-deck', EXAMPLE_DECK_NAME);
    const result = await dedupeExampleEntries([keepDeck, oldDeck, olderDeck]);

    expect(result).toEqual([keepDeck]);
    expect(deleteEntry).toHaveBeenCalledTimes(2);
    expect(deleteEntry).toHaveBeenCalledWith(oldDeck);
    expect(deleteEntry).toHaveBeenCalledWith(olderDeck);
  });

  it('never touches user entries, even with duplicate names', async () => {
    const entries = [entry('1', 'My Shader'), entry('2', 'My Shader')];
    expect(await dedupeExampleEntries(entries)).toBe(entries);
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it('survives delete failures', async () => {
    deleteEntry.mockRejectedValue(new Error('locked'));
    const result = await dedupeExampleEntries([
      entry('a', EXAMPLE_DECK_NAME),
      entry('b', EXAMPLE_DECK_NAME),
    ]);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });
});

describe('seedExampleLibrary', () => {
  it('creates the full example library (16 shaders, 4 scenes, 5 sprites, 4 models, 10 decks)', async () => {
    const { deck, entries } = await seedExampleLibrary();

    expect(saveShader).toHaveBeenCalledTimes(16);
    expect(saveScene).toHaveBeenCalledTimes(4);
    expect(saveAssetFromBuffer).toHaveBeenCalledTimes(9); // 5 sprites + 4 models
    expect(saveDeck).toHaveBeenCalledTimes(10);

    expect(deck.name).toBe(EXAMPLE_DECK_NAME);
    expect(entries).toHaveLength(16 + 4 + 9 + 10);
    expect(entries[0]).toBe(deck); // newest-first, primary deck on top
  });

  it('wires the welcome deck channels to saved entry ids', async () => {
    const { deck, entries } = await seedExampleLibrary();
    const byName = (name) => entries.find((e) => e.name === name);
    const [ch1, ch2, ch3, ch4] = deck.channels;
    expect(ch1.shaderId).toBe(byName('Example · Plasma Flow').id);
    expect(ch2.shaderId).toBe(byName('Example · Neon Rings').id);
    expect(ch3.modelId).toBe(byName('Example · Torus').id);
    expect(ch4.spriteId).toBe(byName('Example · Neon Star').id);
  });

  it('every deck channel references an id that exists in the library', async () => {
    const { entries } = await seedExampleLibrary();
    const ids = new Set(entries.map((e) => e.id));
    const decks = entries.filter((e) => e.kind === 'deck');
    expect(decks).toHaveLength(10);
    decks.forEach((d) => {
      d.channels.forEach((ch) => {
        const ref =
          ch.shaderId ?? ch.spriteId ?? ch.modelId ?? ch.landscapeId ?? ch.sceneId ?? ch.videoId;
        expect(ref, `${d.name} channel ref`).toBeTruthy();
        expect(ids.has(ref)).toBe(true);
      });
    });
  });

  it('every channel carries the full config shape', async () => {
    const { entries } = await seedExampleLibrary();
    const decks = entries.filter((e) => e.kind === 'deck');
    decks.forEach((d) =>
      d.channels.forEach((ch) => {
        expect(ch).toMatchObject({
          size: { x: expect.any(Number), y: expect.any(Number) },
          fx: expect.objectContaining({ band: expect.any(String), contrast: expect.any(Number) }),
        });
        expect(Object.keys(ch.aut).sort()).toEqual(['dst', 'flk', 'rot', 'scl', 'skw', 'tlt']);
        expect(ch.opacity).toBeGreaterThanOrEqual(0);
      }),
    );
    // the welcome deck's channel 1 starts audible so first launch is visible
    const welcome = decks.find((d) => d.name === EXAMPLE_DECK_NAME);
    expect(welcome.channels[0].opacity).toBe(1);
  });

  it('the seeded models are valid binary STLs', async () => {
    await seedExampleLibrary();
    const stlCalls = saveAssetFromBuffer.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg.kind === 'model');
    expect(stlCalls.map((c) => c.name)).toEqual([
      'Example · Torus',
      'Example · Sphere',
      'Example · Spike Ball',
      'Example · Vapor Terrain',
    ]);

    stlCalls.forEach((call) => {
      expect(call.ext).toBe('.stl');
      const dv = new DataView(call.bytes.buffer);
      const triCount = dv.getUint32(80, true);
      expect(call.bytes.byteLength).toBe(84 + triCount * 50);
    });

    const torus = stlCalls.find((c) => c.name === 'Example · Torus');
    const terrain = stlCalls.find((c) => c.name === 'Example · Vapor Terrain');
    expect(new DataView(torus.bytes.buffer).getUint32(80, true)).toBe(48 * 24 * 2);
    expect(new DataView(terrain.bytes.buffer).getUint32(80, true)).toBe(56 * 42 * 2);
  });

  it('seeds procedural scenes with the example prefix', async () => {
    await seedExampleLibrary();
    const names = saveScene.mock.calls.map(([arg]) => arg.name);
    expect(names).toContain('Example · Wormhole');
    expect(names.every((n) => n.startsWith('Example · '))).toBe(true);
  });
});
