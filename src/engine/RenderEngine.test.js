import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom has no WebGL: mock three with just enough shape for the engine's
// bookkeeping (uniform routing, staging, mode swaps) to run for real.
const glState = { compileOk: true, infoLog: 'ERROR: fake compile failure' };

vi.mock('three', () => {
  class Vector2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    set(x, y) { this.x = x; this.y = y; return this; }
    copy(v) { this.x = v.x; this.y = v.y; return this; }
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s) { return this.set(s, s, s); }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  }
  class Vector4 {
    constructor(x = 0, y = 0, z = 0, w = 0) { Object.assign(this, { x, y, z, w }); }
    set(x, y, z, w) { Object.assign(this, { x, y, z, w }); return this; }
    copy(v) { return this.set(v.x, v.y, v.z, v.w); }
  }
  class Object3D {
    constructor() {
      this.children = [];
      this.position = new Vector3();
      this.rotation = { x: 0, y: 0, z: 0 };
      this.scale = new Vector3(1, 1, 1);
      this.visible = true;
      this.frustumCulled = true;
    }
    add(child) { this.children.push(child); return this; }
    traverse(fn) {
      fn(this);
      this.children.forEach((c) => c.traverse(fn));
    }
  }
  class Scene extends Object3D {}
  class Group extends Object3D {}
  class Mesh extends Object3D {
    constructor(geometry, material) {
      super();
      this.geometry = geometry;
      this.material = material;
    }
  }
  class ShaderMaterial {
    constructor({ uniforms, vertexShader, fragmentShader, transparent } = {}) {
      Object.assign(this, { uniforms, vertexShader, fragmentShader, transparent });
      this.dispose = vi.fn();
    }
  }
  class PlaneGeometry { dispose() {} }
  class WebGLRenderTarget {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.texture = { wrapS: null, wrapT: null };
      this.setSize = vi.fn((w, h) => { this.width = w; this.height = h; });
      this.dispose = vi.fn();
    }
  }
  class WebGLRenderer {
    constructor() {
      this.domElement = document.createElement('canvas');
      this.debug = {};
      this.setClearColor = vi.fn();
      this.setRenderTarget = vi.fn();
      this.render = vi.fn();
      this.setSize = vi.fn();
      this.setPixelRatio = vi.fn();
      this.initTexture = vi.fn();
      this.readRenderTargetPixels = vi.fn();
      this.compileAsync = vi.fn().mockResolvedValue();
      this.dispose = vi.fn();
      this.getContext = () => ({
        FRAGMENT_SHADER: 0x8b30,
        COMPILE_STATUS: 0x8b81,
        createShader: () => ({}),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: () => glState.compileOk,
        getShaderInfoLog: () => glState.infoLog,
        deleteShader: vi.fn(),
      });
    }
  }
  class Camera extends Object3D {
    constructor() {
      super();
      this.aspect = 1;
      this.updateProjectionMatrix = vi.fn();
    }
    lookAt() {}
  }
  class Box3 {
    setFromObject() { return this; }
    getSize(v) { return v.set(2, 2, 2); }
    getCenter(v) { return v.set(0, 0, 0); }
  }
  class Light extends Object3D { constructor() { super(); } }
  return {
    Vector2,
    Vector3,
    Vector4,
    Scene,
    Group,
    Mesh,
    ShaderMaterial,
    PlaneGeometry,
    WebGLRenderTarget,
    WebGLRenderer,
    OrthographicCamera: Camera,
    PerspectiveCamera: Camera,
    AmbientLight: Light,
    DirectionalLight: Light,
    Box3,
    Clock: class Clock { getElapsedTime() { return 0; } },
    MirroredRepeatWrapping: 'mirror',
  };
});

import { RenderEngine, CHANNELS, SCENES } from './RenderEngine';
import { DEFAULT_DECK_BODIES } from './shaders';

const makeEngine = ({ audio } = {}) =>
  new RenderEngine({ a: null, b: null }, [], audio ?? null);

beforeEach(() => {
  glState.compileOk = true;
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

describe('construction', () => {
  it('builds 8 deck slots (2 scenes x 4 channels) with the default bodies', () => {
    const engine = makeEngine();
    expect(CHANNELS * SCENES).toBe(8);
    expect(engine.decks).toHaveLength(8);
    engine.decks.forEach((deck, i) => {
      expect(deck.mode).toBe('shader');
      expect(deck.body).toBe(DEFAULT_DECK_BODIES[i]);
    });
  });

  it('starts with channel 1 of each scene audible', () => {
    const engine = makeEngine();
    expect(engine.slotUniforms.map((u) => u.mix.value)).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
  });
});

describe('uniform setters', () => {
  it('routes opacity/scale/size/fx/crossfade into the slot uniforms', () => {
    const engine = makeEngine();
    engine.setOpacity(3, 0.7);
    engine.setScale(3, 2);
    engine.setSize(3, 0.5, 0.25);
    engine.setChannelFx(3, 0.1, 1.2, -0.3, 0.8);
    engine.setCrossfade(0.4);

    const slot = engine.slotUniforms[3];
    expect(slot.mix.value).toBe(0.7);
    expect(slot.scale.value).toBe(2);
    expect(slot.size.value).toMatchObject({ x: 0.5, y: 0.25 });
    expect(slot.fx.value).toMatchObject({ x: 0.1, y: 1.2, z: -0.3, w: 0.8 });
    expect(engine.xfadeUniform.value).toBe(0.4);
  });

  it('slot uniforms are shared by reference with scene and master composites', () => {
    const engine = makeEngine();
    engine.setOpacity(5, 0.33);
    const sceneB = engine.sceneComposites[1].children[0].material.uniforms;
    const master = engine.masterComposite.children[0].material.uniforms;
    expect(sceneB.u_mix2.value).toBe(0.33); // slot 5 = scene B channel 2
    expect(master.u_mix6.value).toBe(0.33);
    expect(sceneB.u_mix2).toBe(master.u_mix6);
  });
});

describe('audio routing', () => {
  const fakeAudio = { update: () => ({ low: 0.8, mid: 0.4, high: 0.2, level: 0.6 }) };

  it('drives per-deck audio uniforms through band and amt', () => {
    const engine = makeEngine({ audio: fakeAudio });
    engine.setAudioRouting(0, 'low', 1);
    engine.setAudioRouting(1, 'level', 0.5);
    engine.loop();

    const deck0 = engine.deckAudioUniforms[0];
    expect(deck0.u_audio_low.value).toBeCloseTo(0.8);
    expect(deck0.u_audio_level.value).toBeCloseTo(0.8); // routed from 'low'

    const deck1 = engine.deckAudioUniforms[1];
    expect(deck1.u_audio_low.value).toBeCloseTo(0.4); // amt halves everything
    expect(deck1.u_audio_level.value).toBeCloseTo(0.3);
  });

  it('clamps boosted values to the 0..1 uniform contract', () => {
    const engine = makeEngine({ audio: fakeAudio });
    engine.setAudioRouting(0, 'low', 2);
    engine.loop();
    expect(engine.deckAudioUniforms[0].u_audio_low.value).toBe(1);
  });

  it('falls back to overall level for an unknown band', () => {
    const engine = makeEngine({ audio: fakeAudio });
    engine.setAudioRouting(0, 'nonsense', 1);
    engine.loop();
    expect(engine.deckAudioUniforms[0].u_audio_level.value).toBeCloseTo(0.6);
  });
});

describe('stageShader', () => {
  const BODY = 'void main() { gl_FragColor = vec4(1.0); }';

  it('swaps the deck body and disposes the old material on success', () => {
    const engine = makeEngine();
    const oldMaterial = engine.decks[2].mesh.material;

    const result = engine.stageShader(2, BODY);
    expect(result).toEqual({ ok: true });
    expect(engine.getShaderBody(2)).toBe(BODY);
    expect(engine.decks[2].mode).toBe('shader');
    expect(oldMaterial.dispose).toHaveBeenCalled();
    expect(engine.getChannelSource(2)).toEqual({ type: 'shader', code: BODY });
  });

  it('rejects on precompile failure and keeps the old shader', () => {
    const engine = makeEngine();
    glState.compileOk = false;
    const before = engine.decks[2].mesh.material;

    const result = engine.stageShader(2, BODY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fake compile failure');
    expect(engine.decks[2].mesh.material).toBe(before);
    expect(engine.getShaderBody(2)).toBe(DEFAULT_DECK_BODIES[2]);
  });

  it('rejects when the staging render reports a three-level shader error', () => {
    const engine = makeEngine();
    const before = engine.decks[2].mesh.material;
    engine.renderer.render = vi.fn(() => {
      engine.shaderError = 'three says no';
    });

    const result = engine.stageShader(2, BODY);
    expect(result).toEqual({ ok: false, error: 'three says no' });
    expect(engine.decks[2].mesh.material).toBe(before);
    expect(engine.shaderError).toBeNull();
  });

  it('staging a shader over a sprite clears the sprite', () => {
    const engine = makeEngine();
    const texture = { dispose: vi.fn() };
    engine.stageSprite(1, texture, 1.5, 'sprite-1');
    expect(engine.getChannelSource(1)).toEqual({ type: 'sprite', spriteId: 'sprite-1' });

    engine.stageShader(1, BODY);
    expect(engine.decks[1].sprite).toBeNull();
    expect(texture.dispose).toHaveBeenCalled();
    expect(engine.getChannelSource(1)).toEqual({ type: 'shader', code: BODY });
  });
});

describe('stageSprite', () => {
  it('pre-uploads the texture and switches the deck to sprite mode', () => {
    const engine = makeEngine();
    const texture = { dispose: vi.fn() };
    const result = engine.stageSprite(4, texture, 2, 'sprite-9');

    expect(result).toEqual({ ok: true });
    expect(engine.renderer.initTexture).toHaveBeenCalledWith(texture);
    expect(engine.decks[4].mode).toBe('sprite');
    expect(engine.getChannelSource(4)).toEqual({ type: 'sprite', spriteId: 'sprite-9' });
  });

  it('contain-fits the sprite using the image aspect', () => {
    const engine = makeEngine();
    engine.aspectUniform.value = 16 / 9;
    engine.stageSprite(0, { dispose: vi.fn() }, 1, 's');
    const sprite = engine.decks[0].sprite;
    // square image in a 16:9 frame: height capped at 1.7
    expect(sprite.baseH).toBeCloseTo(1.7);
    expect(sprite.baseW).toBeCloseTo(1.7);

    engine.stageSprite(0, { dispose: vi.fn() }, 4, 'wide');
    // very wide image: width-limited instead
    const wide = engine.decks[0].sprite;
    expect(wide.baseH).toBeCloseTo((1.7 * (16 / 9)) / 4);
    expect(wide.baseW).toBeCloseTo(wide.baseH * 4);
  });

  it('replacing a sprite disposes the previous texture', () => {
    const engine = makeEngine();
    const first = { dispose: vi.fn() };
    engine.stageSprite(0, first, 1, 'a');
    engine.stageSprite(0, { dispose: vi.fn() }, 1, 'b');
    expect(first.dispose).toHaveBeenCalled();
    expect(engine.getChannelSource(0).spriteId).toBe('b');
  });
});

describe('stageModel', () => {
  const makeObject = async () => {
    const { Group } = await import('three');
    return new Group();
  };

  it('precompiles, warms up, then swaps to model mode', async () => {
    const engine = makeEngine();
    const object = await makeObject();

    const result = await engine.stageModel(6, object, 'model-3');
    expect(result).toEqual({ ok: true });
    expect(engine.renderer.compileAsync).toHaveBeenCalled();
    expect(engine.decks[6].mode).toBe('model');
    expect(engine.getChannelSource(6)).toEqual({ type: 'model', modelId: 'model-3' });
    // normalized: 2.2 / maxDim(2) = 1.1
    expect(engine.decks[6].model.baseScale).toBeCloseTo(1.1);
  });

  it('continues when async compile fails (worst case: inline compile)', async () => {
    const engine = makeEngine();
    engine.renderer.compileAsync = vi.fn().mockRejectedValue(new Error('nope'));
    const result = await engine.stageModel(6, await makeObject(), 'model-3');
    expect(result).toEqual({ ok: true });
    expect(engine.decks[6].mode).toBe('model');
  });
});

describe('aspect settling', () => {
  it('only reallocates deck targets after the aspect holds steady', () => {
    const engine = makeEngine();
    const initial = engine.appliedAspect;
    const target = engine.decks[0].target;

    engine.maybeResizeDecks(2.0); // first sighting: pending only
    expect(engine.appliedAspect).toBe(initial);

    for (let i = 0; i < 11; i += 1) engine.maybeResizeDecks(2.0);
    expect(engine.appliedAspect).toBe(initial); // still settling

    engine.maybeResizeDecks(2.0); // 12th stable frame applies it
    expect(engine.appliedAspect).toBe(2.0);
    expect(engine.deckHeight).toBe(480);
    expect(target.setSize).toHaveBeenCalledWith(960, 480);
  });

  it('a changing aspect resets the settle counter', () => {
    const engine = makeEngine();
    const initial = engine.appliedAspect;
    for (let i = 0; i < 10; i += 1) engine.maybeResizeDecks(2.0);
    engine.maybeResizeDecks(3.0); // resize drag continues
    for (let i = 0; i < 11; i += 1) engine.maybeResizeDecks(3.0);
    expect(engine.appliedAspect).toBe(initial);
    engine.maybeResizeDecks(3.0);
    expect(engine.appliedAspect).toBe(3.0);
  });

  it('ignores sub-1% aspect jitter', () => {
    const engine = makeEngine();
    const initial = engine.appliedAspect;
    for (let i = 0; i < 30; i += 1) engine.maybeResizeDecks(initial + 0.005);
    expect(engine.appliedAspect).toBe(initial);
  });
});

describe('snapshots and disposal', () => {
  it('getSceneDataURL returns null for an unsized canvas', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 0;
    const engine = new RenderEngine({ a: canvas, b: null }, [], null);
    expect(engine.getSceneDataURL(0)).toBeNull();
  });

  it('getPreviewDataURL returns null without a preview canvas', () => {
    const engine = makeEngine();
    expect(engine.getPreviewDataURL(0)).toBeNull();
  });

  it('dispose stops the loop and releases GPU resources', () => {
    const engine = makeEngine();
    engine.dispose();
    expect(engine.running).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(engine.raf);
    engine.decks.forEach((deck) => {
      expect(deck.mesh.material.dispose).toHaveBeenCalled();
      expect(deck.target.dispose).toHaveBeenCalled();
    });
    expect(engine.renderer.dispose).toHaveBeenCalled();

    engine.loop(); // a stray queued frame after dispose must be a no-op
    expect(engine.frame).toBe(0);
  });
});
