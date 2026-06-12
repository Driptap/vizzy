import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./shaderLibrary', () => {
  let n = 0;
  return {
    saveShader: vi.fn(async (data) => ({ id: `shader-${++n}`, createdAt: n, ...data })),
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
import { saveShader, saveDeck, saveAssetFromBuffer, deleteEntry } from './shaderLibrary';

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
  it('creates 2 shaders, a sprite, 2 models and the deck preset', async () => {
    const { deck, entries } = await seedExampleLibrary();

    expect(saveShader).toHaveBeenCalledTimes(2);
    expect(saveAssetFromBuffer).toHaveBeenCalledTimes(3); // star sprite, torus, vapor terrain
    expect(saveDeck).toHaveBeenCalledTimes(1);

    expect(deck.name).toBe(EXAMPLE_DECK_NAME);
    expect(entries).toHaveLength(6);
    expect(entries[0]).toBe(deck); // newest-first, deck on top
  });

  it('wires the deck channels to the saved entry ids', async () => {
    const { deck, entries } = await seedExampleLibrary();
    const byKind = Object.groupBy
      ? Object.groupBy(entries, (e) => e.kind ?? 'shader')
      : entries.reduce((acc, e) => {
          const k = e.kind ?? 'shader';
          (acc[k] ??= []).push(e);
          return acc;
        }, {});

    const [ch1, ch2, ch3, ch4] = deck.channels;
    const torus = entries.find((e) => e.name === 'Example · Torus');
    expect(byKind.shader.map((e) => e.id)).toContain(ch1.shaderId);
    expect(byKind.sprite[0].id).toBe(ch2.spriteId);
    expect(ch3.modelId).toBe(torus.id);
    expect(byKind.shader.map((e) => e.id)).toContain(ch4.shaderId);
    expect(ch1.shaderId).not.toBe(ch4.shaderId);
  });

  it('every channel carries the full config shape', async () => {
    const { deck } = await seedExampleLibrary();
    deck.channels.forEach((ch) => {
      expect(ch).toMatchObject({
        size: { x: expect.any(Number), y: expect.any(Number) },
        fx: expect.objectContaining({ band: expect.any(String), contrast: expect.any(Number) }),
      });
      expect(Object.keys(ch.aut).sort()).toEqual(['dst', 'flk', 'rot', 'scl', 'skw', 'tlt']);
      expect(ch.opacity).toBeGreaterThanOrEqual(0);
    });
    // channel 1 starts audible so the seeded deck is visible immediately
    expect(deck.channels[0].opacity).toBe(1);
  });

  it('the seeded torus and vapor terrain are valid binary STLs', async () => {
    await seedExampleLibrary();
    const stlCalls = saveAssetFromBuffer.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg.kind === 'model');
    expect(stlCalls.map((c) => c.name)).toEqual(['Example · Torus', 'Example · Vapor Terrain']);

    stlCalls.forEach((call) => {
      expect(call.ext).toBe('.stl');
      const dv = new DataView(call.bytes.buffer);
      const triCount = dv.getUint32(80, true);
      expect(call.bytes.byteLength).toBe(84 + triCount * 50);
    });

    const [torus, terrain] = stlCalls;
    expect(new DataView(torus.bytes.buffer).getUint32(80, true)).toBe(48 * 24 * 2);
    expect(new DataView(terrain.bytes.buffer).getUint32(80, true)).toBe(56 * 42 * 2);
  });
});
