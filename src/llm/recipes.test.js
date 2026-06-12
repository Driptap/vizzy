import { describe, it, expect } from 'vitest';
import { STYLE_RECIPES, selectRecipe } from './recipes';

describe('STYLE_RECIPES', () => {
  it('has unique ids', () => {
    const ids = STYLE_RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every recipe has title, keywords and guidance', () => {
    STYLE_RECIPES.forEach((recipe) => {
      expect(recipe.title).toBeTruthy();
      expect(recipe.keywords.length).toBeGreaterThan(0);
      expect(recipe.guidance.length).toBeGreaterThan(50);
    });
  });

  it('keywords are lowercase (matching is done on a lowercased prompt)', () => {
    STYLE_RECIPES.forEach((recipe) => {
      recipe.keywords.forEach((kw) => expect(kw).toBe(kw.toLowerCase()));
    });
  });

  it('guidance bodies contain no backticks or ${ (they live in template literals)', () => {
    STYLE_RECIPES.forEach((recipe) => {
      expect(recipe.guidance).not.toContain('`');
      expect(recipe.guidance).not.toContain('${');
    });
  });
});

describe('selectRecipe', () => {
  it('returns null when nothing matches', () => {
    expect(selectRecipe('a calm gradient of blues')).toBeNull();
  });

  it('returns null for empty or missing prompts', () => {
    expect(selectRecipe('')).toBeNull();
    expect(selectRecipe(null)).toBeNull();
    expect(selectRecipe(undefined)).toBeNull();
  });

  it('matches single keywords case-insensitively', () => {
    expect(selectRecipe('A trippy FRACTAL zoom').id).toBe('fractal');
    expect(selectRecipe('fly through a wormhole').id).toBe('tunnel');
    expect(selectRecipe('winamp style bars').id).toBe('winamp');
  });

  it('matches keywords embedded in words', () => {
    // substring match by design: "mandel" matches "mandelbrot zoom"
    expect(selectRecipe('mandelbrot deep zoom').id).toBe('fractal');
  });

  it('scores by total matched keyword length, best recipe wins', () => {
    // 'tunnel' (6) + 'vortex' (6) = 12 for tunnel vs 'fractal' (7) = 7
    expect(selectRecipe('a fractal tunnel vortex').id).toBe('tunnel');
  });

  it('accumulates multiple keyword hits within one recipe', () => {
    expect(selectRecipe('raymarch a 3d torus landscape').id).toBe('raymarch');
  });
});
