import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG, catalogEntry } from './models';
import { DEFAULT_MODEL } from './ollama';

describe('MODEL_CATALOG', () => {
  it('has unique tags', () => {
    const tags = MODEL_CATALOG.map((m) => m.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('has exactly one default, and it is the app default model', () => {
    const defaults = MODEL_CATALOG.filter((m) => m.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].tag).toBe(DEFAULT_MODEL);
  });

  it('every entry has display fields', () => {
    MODEL_CATALOG.forEach((m) => {
      expect(m.name).toBeTruthy();
      expect(m.download).toMatch(/GB$/);
      expect(m.ram).toMatch(/GB$/);
      expect(m.blurb).toBeTruthy();
    });
  });
});

describe('catalogEntry', () => {
  it('finds an entry by tag', () => {
    expect(catalogEntry('qwen2.5-coder').name).toBe('Qwen2.5 Coder 7B');
  });

  it('returns null for unknown tags', () => {
    expect(catalogEntry('not-a-model')).toBeNull();
    expect(catalogEntry('')).toBeNull();
  });
});
