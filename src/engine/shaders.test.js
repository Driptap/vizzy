import { describe, it, expect } from 'vitest';
import {
  FRAGMENT_HEADER,
  buildFragmentShader,
  DEFAULT_DECK_BODIES,
  SCENE_FRAGMENT,
  COMPOSITE_FRAGMENT,
  PREVIEW_FRAGMENT,
  SPRITE_FRAGMENT,
} from './shaders';

// crude but effective balance check for generated GLSL strings
const balanced = (src) =>
  [...src].reduce((depth, ch) => depth + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0) === 0;

describe('buildFragmentShader', () => {
  it('prepends the engine header to the body', () => {
    const body = 'void main() { gl_FragColor = vec4(1.0); }';
    const full = buildFragmentShader(body);
    expect(full.startsWith(FRAGMENT_HEADER)).toBe(true);
    expect(full).toContain(body);
  });

  it('header declares every uniform the LLM contract promises', () => {
    ['u_time', 'u_resolution', 'u_audio_low', 'u_audio_mid', 'u_audio_high', 'u_audio_level', 'vUv'].forEach(
      (name) => expect(FRAGMENT_HEADER).toContain(name),
    );
  });
});

describe('DEFAULT_DECK_BODIES', () => {
  it('provides one body per slot (2 scenes x 4 channels)', () => {
    expect(DEFAULT_DECK_BODIES).toHaveLength(8);
  });

  it('each body is a distinct, brace-balanced main()', () => {
    DEFAULT_DECK_BODIES.forEach((body) => {
      expect(body).toContain('void main()');
      expect(balanced(body)).toBe(true);
    });
    expect(new Set(DEFAULT_DECK_BODIES).size).toBe(8);
  });
});

describe('composite shaders', () => {
  it('scene composite mixes 4 decks through the layer stack', () => {
    for (let i = 1; i <= 4; i += 1) {
      expect(SCENE_FRAGMENT).toContain(`u_deck${i}`);
      expect(SCENE_FRAGMENT).toContain(`u_mix${i}`);
      expect(SCENE_FRAGMENT).toContain(`u_layer${i}`);
    }
    expect(SCENE_FRAGMENT).not.toContain('u_deck5');
    expect(SCENE_FRAGMENT).toContain('layerStack(');
  });

  it('master composite crossfades 8 decks', () => {
    for (let i = 1; i <= 8; i += 1) {
      expect(COMPOSITE_FRAGMENT).toContain(`u_deck${i}`);
      expect(COMPOSITE_FRAGMENT).toContain(`u_fx${i}`);
      expect(COMPOSITE_FRAGMENT).toContain(`u_warp${i}`);
      expect(COMPOSITE_FRAGMENT).toContain(`u_layer${i}`);
    }
    expect(COMPOSITE_FRAGMENT).toContain('u_xfade');
    // layering happens per scene BEFORE the crossfade
    expect(COMPOSITE_FRAGMENT).toMatch(/layerStack\(d1.*u_layer4\)/s);
    expect(COMPOSITE_FRAGMENT).toMatch(/layerStack\(d5.*u_layer8\)/s);
  });

  it('all composite sources are brace-balanced and share the deck sampler', () => {
    [SCENE_FRAGMENT, COMPOSITE_FRAGMENT, PREVIEW_FRAGMENT].forEach((src) => {
      expect(balanced(src)).toBe(true);
      expect(src).toContain('vec4 deckColor(');
    });
    expect(balanced(SPRITE_FRAGMENT)).toBe(true);
  });
});
