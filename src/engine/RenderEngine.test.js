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
    copy(v) { return this.set(v.x, v.y, v.z); }
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
    clone() { return new this.constructor(); }
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
    constructor() {
      this.min = new Vector3(-1, -1, -1);
      this.max = new Vector3(1, 1, 1);
    }
    setFromObject() { return this; }
    getSize(v) { return v.set(2, 2, 2); }
    getCenter(v) { return v.set(0, 0, 0); }
  }
  class Light extends Object3D {
    constructor(color, intensity = 1) {
      super();
      this.color = color;
      this.intensity = intensity;
    }
  }
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
    Clock: class Clock {
      constructor() { this.t = 0; }
      // advances a fake 16ms per frame so loop dt is non-zero
      getElapsedTime() { this.t += 0.016; return this.t; }
    },
    Fog: class Fog {
      constructor(color, near, far) { Object.assign(this, { color, near, far }); }
    },
    MirroredRepeatWrapping: 'mirror',
    DoubleSide: 'double-side',
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

  it('decks start on the base layer and setLayer reaches every composite', () => {
    const engine = makeEngine();
    engine.slotUniforms.forEach((u) => expect(u.layer.value).toBe(4));

    engine.setLayer(5, 1); // scene B channel 2 to the top
    const sceneB = engine.sceneComposites[1].children[0].material.uniforms;
    const master = engine.masterComposite.children[0].material.uniforms;
    expect(sceneB.u_layer2.value).toBe(1);
    expect(master.u_layer6.value).toBe(1);
    expect(sceneB.u_layer2).toBe(master.u_layer6); // shared by reference
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

describe('shader-deck composite automation', () => {
  const loudAudio = { update: () => ({ low: 1, mid: 1, high: 1, level: 1 }) };

  it('the loop modulates a shader deck around its knob-set base values', () => {
    const engine = makeEngine({ audio: loudAudio });
    engine.setScale(0, 2);
    engine.setChannelFx(0, 0.5, 1, 0, 1);
    engine.setAutomation(0, {
      scl: { amt: 1, audio: true },
      rot: { amt: 1, audio: true },
      tlt: { amt: 0, audio: false },
      flk: { amt: 0, audio: false },
      dst: { amt: 1, audio: true },
      skw: { amt: 1, audio: true },
    });

    engine.loop();
    engine.loop(); // dt > 0 from the second frame on

    const slot = engine.slotUniforms[0];
    expect(slot.scale.value).toBeCloseTo(2 * 1.4); // SCL pulse on base scale
    expect(slot.fx.value.x).toBeGreaterThan(0.5); // ROT spin on top of TILT
    expect(slot.warp.value.x).toBeCloseTo(1); // DST
    expect(slot.warp.value.y).toBeCloseTo(0.7); // SKW
    // base survives untouched: re-sync from React lands on the knob values
    expect(engine.baseParams[0].scale).toBe(2);
    expect(engine.baseParams[0].fx.x).toBeCloseTo(0.5);
  });

  it('idle automation leaves the uniforms at their base values', () => {
    const engine = makeEngine({ audio: loudAudio });
    engine.setScale(0, 2);
    engine.setOpacity(0, 0.6);
    engine.loop();
    const slot = engine.slotUniforms[0];
    expect(slot.scale.value).toBe(2);
    expect(slot.mix.value).toBe(0.6);
    expect(slot.warp.value).toMatchObject({ x: 0, y: 0 });
  });

  it('non-shader decks keep composite params pinned to base (no double automation)', async () => {
    const engine = makeEngine({ audio: loudAudio });
    engine.stageSprite(1, { dispose: vi.fn() }, 1, 'sprite-1');
    engine.setScale(1, 1.5);
    engine.setAutomation(1, {
      scl: { amt: 1, audio: true },
      rot: { amt: 1, audio: true },
      tlt: { amt: 0, audio: false },
      flk: { amt: 0, audio: false },
      dst: { amt: 1, audio: true },
      skw: { amt: 1, audio: true },
    });

    engine.loop();
    engine.loop();

    const slot = engine.slotUniforms[1];
    expect(slot.scale.value).toBe(1.5); // sprite animates in-scene instead
    expect(slot.warp.value).toMatchObject({ x: 0, y: 0 });
    expect(engine.decks[1].sprite.mesh.scale.x).not.toBe(1); // in-scene AUT ran
  });
});

describe('stageLandscape', () => {
  const makeObject = async () => {
    const { Group } = await import('three');
    return new Group();
  };

  it('stages a mesh as fly-over terrain with two mirrored tiles', async () => {
    const engine = makeEngine();
    const result = await engine.stageLandscape(5, await makeObject(), 'model-7');

    expect(result).toEqual({ ok: true });
    expect(engine.decks[5].mode).toBe('landscape');
    expect(engine.getChannelSource(5)).toEqual({ type: 'landscape', modelId: 'model-7' });

    const landscape = engine.decks[5].landscape;
    expect(landscape.tiles).toHaveLength(2);
    // mirrored in z so the seam between the copies always lines up
    expect(landscape.tiles[0].scale.z).toBeCloseTo(-landscape.tiles[1].scale.z);
    expect(landscape.span).toBeGreaterThan(0);
    expect(landscape.scene.fog).toBeTruthy();
    expect(landscape.camera.position.y).toBeCloseTo(landscape.camHeight);
  });

  it('replaces a model on the same deck, and a shader stage clears it', async () => {
    const engine = makeEngine();
    await engine.stageModel(2, await makeObject(), 'model-1');
    await engine.stageLandscape(2, await makeObject(), 'model-1');
    expect(engine.decks[2].model).toBeNull();
    expect(engine.getChannelSource(2)).toEqual({ type: 'landscape', modelId: 'model-1' });

    engine.stageShader(2, 'void main() { gl_FragColor = vec4(1.0); }');
    expect(engine.decks[2].landscape).toBeNull();
    expect(engine.getChannelSource(2).type).toBe('shader');
  });

  it('the render loop scrolls the terrain and renders with the landscape camera', async () => {
    const engine = makeEngine({ audio: { update: () => ({ low: 0, mid: 0, high: 0, level: 0.5 }) } });
    await engine.stageLandscape(0, await makeObject(), 'm');
    const landscape = engine.decks[0].landscape;
    engine.renderer.render.mockClear();

    engine.loop();
    engine.loop(); // first loop establishes lastFrameTime; second has dt > 0
    expect(landscape.scroll).toBeGreaterThan(0);
    expect(engine.renderer.render).toHaveBeenCalledWith(landscape.scene, landscape.camera);
  });

  it('POS pans the landscape camera through the render loop', async () => {
    const engine = makeEngine();
    await engine.stageLandscape(0, await makeObject(), 'm');
    engine.setPosition(0, 1.2, 0.8);
    engine.loop();

    const landscape = engine.decks[0].landscape;
    expect(landscape.camera.position.x).toBeCloseTo(1.2, 0);
    expect(landscape.camera.position.y).toBeGreaterThan(landscape.camHeight);
  });

  it('an aspect change updates the landscape camera projection', async () => {
    const engine = makeEngine();
    await engine.stageLandscape(0, await makeObject(), 'm');
    const camera = engine.decks[0].landscape.camera;
    camera.updateProjectionMatrix.mockClear();

    for (let i = 0; i < 13; i += 1) engine.maybeResizeDecks(2.0);
    expect(camera.aspect).toBe(2.0);
    expect(camera.updateProjectionMatrix).toHaveBeenCalled();
  });
});

describe('stageScene', () => {
  const makeObject = async () => {
    const { Group } = await import('three');
    return new Group();
  };
  const terrainSpec = {
    kind: 'terrain',
    surface: 'sin(x)',
    amplitude: 2,
    palette: ['#ff71ce', '#01cdfe', '#1a0533'],
  };
  const tunnelSpec = { ...terrainSpec, kind: 'tunnel' };

  it('terrain scenes fly over with the spec exposed as the channel source', async () => {
    const engine = makeEngine();
    const result = await engine.stageScene(2, await makeObject(), terrainSpec);
    expect(result).toEqual({ ok: true });
    expect(engine.decks[2].mode).toBe('scene');
    expect(engine.getChannelSource(2)).toEqual({ type: 'scene', spec: terrainSpec });

    const content = engine.decks[2].landscape;
    expect(content.fly).toBe('over');
    expect(content.spec).toBe(terrainSpec);
    expect(content.scene.fog.color).toBe('#1a0533'); // fog takes the palette colour
  });

  it('tunnel scenes fly through the axis (camera centred, not grounded)', async () => {
    const engine = makeEngine();
    await engine.stageScene(3, await makeObject(), tunnelSpec);
    const content = engine.decks[3].landscape;
    expect(content.fly).toBe('through');
    expect(content.camHeight).toBe(0);
    expect(content.camera.position.y).toBe(0);
  });

  it('scene decks animate through the shared flight loop', async () => {
    const engine = makeEngine({ audio: { update: () => ({ low: 0, mid: 0, high: 0, level: 0.5 }) } });
    await engine.stageScene(0, await makeObject(), tunnelSpec);
    const content = engine.decks[0].landscape;
    engine.renderer.render.mockClear();
    engine.loop();
    engine.loop();
    expect(content.scroll).toBeGreaterThan(0);
    expect(engine.renderer.render).toHaveBeenCalledWith(content.scene, content.camera);
  });

  it('a scene replaces a landscape and is cleared by a shader stage', async () => {
    const engine = makeEngine();
    await engine.stageLandscape(1, await makeObject(), 'model-1');
    await engine.stageScene(1, await makeObject(), terrainSpec);
    expect(engine.getChannelSource(1).type).toBe('scene');
    engine.stageShader(1, 'void main() { gl_FragColor = vec4(1.0); }');
    expect(engine.decks[1].landscape).toBeNull();
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

describe('channel lighting', () => {
  const makeObject = async () => {
    const { Group } = await import('three');
    return new Group();
  };

  it('the loop applies brightness and key orbit to a model deck rig', async () => {
    const engine = makeEngine();
    await engine.stageModel(0, await makeObject(), 'model-1');
    engine.setLighting(0, 0.5, Math.PI);
    engine.loop();

    const rig = engine.decks[0].model.rig;
    expect(rig.key.intensity).toBeCloseTo(1.6 * 0.5);
    expect(rig.ambient.intensity).toBeCloseTo(0.5 * 0.5);
    // orbited half a turn from (2, _, 4)
    expect(rig.key.position.x).toBeCloseTo(-2);
    expect(rig.key.position.z).toBeCloseTo(-4);
    expect(rig.key.position.y).toBeCloseTo(3);
  });

  it('mesh landscapes and procedural scenes are both lit and adjustable', async () => {
    const engine = makeEngine();
    await engine.stageLandscape(1, await makeObject(), 'model-1');
    expect(engine.decks[1].landscape.rig).toBeTruthy();
    engine.setLighting(1, 2, 0);
    engine.loop();
    expect(engine.decks[1].landscape.rig.key.intensity).toBeCloseTo(1.4 * 2);

    await engine.stageScene(2, await makeObject(), {
      kind: 'terrain',
      surface: 'sin(x)',
      amplitude: 2,
      palette: ['#111111', '#222222', '#333333'],
    });
    const sceneRig = engine.decks[2].landscape.rig;
    expect(sceneRig).toBeTruthy();
    expect(sceneRig.keyBase).toBeCloseTo(0.8); // ambient-heavy scene rig
    engine.setLighting(2, 0.5, 0);
    engine.loop();
    expect(sceneRig.key.intensity).toBeCloseTo(0.8 * 0.5);
    expect(sceneRig.ambient.intensity).toBeCloseTo(0.8 * 0.5);
  });
});

describe('resetAllDecks', () => {
  it('returns every deck to its baseline shader and disposes staged content', async () => {
    const engine = makeEngine();
    const { Group } = await import('three');
    const texture = { dispose: vi.fn() };

    engine.stageShader(0, 'void main() { gl_FragColor = vec4(0.5); }');
    engine.stageSprite(1, texture, 1, 'sprite-1');
    await engine.stageModel(2, new Group(), 'model-1');
    await engine.stageLandscape(3, new Group(), 'model-2');
    engine.compositeSpin[0].spin = 4;

    engine.resetAllDecks();

    engine.decks.forEach((deck, i) => {
      expect(deck.mode).toBe('shader');
      expect(deck.body).toBe(DEFAULT_DECK_BODIES[i]);
      expect(deck.model).toBeNull();
      expect(deck.sprite).toBeNull();
      expect(deck.landscape).toBeNull();
    });
    expect(texture.dispose).toHaveBeenCalled();
    expect(engine.compositeSpin[0].spin).toBe(0);
    expect(engine.getChannelSource(2)).toEqual({ type: 'shader', code: DEFAULT_DECK_BODIES[2] });
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
