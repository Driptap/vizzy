import { describe, it, expect, vi } from 'vitest';
import {
  animateLandscapeDeck,
  animateModelDeck,
  animateShaderComposite,
  animateSpriteDeck,
  applyLightRig,
  resetShaderComposite,
} from './automation';
import { makeDefaultAut } from '../lib/channels';

const makeLandscape = ({ span = 9, camHeight = 2 } = {}) => ({
  scene: { visible: true },
  tiles: [
    { position: { z: 0 }, scale: { y: 1 } },
    { position: { z: 0 }, scale: { y: 1 } },
  ],
  camera: {
    position: { x: 0, y: 0, z: 4 },
    rotation: { z: 0 },
    lookAt: vi.fn(),
  },
  modelId: 'm',
  span,
  camHeight,
  scroll: 0,
});

describe('animateLandscapeDeck', () => {
  it('scrolls the terrain forward every frame, faster with audio', () => {
    const quiet = makeLandscape();
    const loud = makeLandscape();
    animateLandscapeDeck(quiet, makeDefaultAut(), 0, 1, 0.1);
    animateLandscapeDeck(loud, makeDefaultAut(), 1, 1, 0.1);
    expect(quiet.scroll).toBeGreaterThan(0);
    expect(loud.scroll).toBeGreaterThan(quiet.scroll);
  });

  it('keeps the two tiles one span apart and wraps them around the camera', () => {
    const landscape = makeLandscape({ span: 9 });
    landscape.scroll = 8.9; // tile 0 about to pass the wrap point
    animateLandscapeDeck(landscape, makeDefaultAut(), 0, 1, 0.5);

    const [z0, z1] = landscape.tiles.map((tile) => tile.position.z);
    expect(Math.abs(z0 - z1)).toBeCloseTo(9, 5);
    landscape.tiles.forEach((tile) => {
      expect(tile.position.z).toBeGreaterThanOrEqual(-9);
      expect(tile.position.z).toBeLessThan(9);
    });
  });

  it('SCL pulses the terrain height with audio when coupled', () => {
    const landscape = makeLandscape();
    const aut = { ...makeDefaultAut(), scl: { amt: 1, audio: true } };
    animateLandscapeDeck(landscape, aut, 1, 1, 0.016);
    expect(landscape.tiles[0].scale.y).toBeCloseTo(1.6);
    animateLandscapeDeck(landscape, aut, 0, 1, 0.016);
    expect(landscape.tiles[0].scale.y).toBeCloseTo(1);
  });

  it('keeps the camera near its base height and re-aims every frame', () => {
    const landscape = makeLandscape({ camHeight: 2 });
    animateLandscapeDeck(landscape, makeDefaultAut(), 0, 1, 0.016);
    expect(landscape.camera.lookAt).toHaveBeenCalled();
    expect(landscape.camera.position.y).toBeGreaterThan(1.5);
    expect(landscape.camera.position.y).toBeLessThan(2.5);
  });

  it('SKW leans the camera roll after aiming', () => {
    const landscape = makeLandscape();
    const aut = { ...makeDefaultAut(), skw: { amt: 1, audio: true } };
    animateLandscapeDeck(landscape, aut, 1, 1, 0.016);
    expect(landscape.camera.rotation.z).not.toBe(0);
  });

  it('FLK blinks the whole frame', () => {
    const landscape = makeLandscape();
    const aut = { ...makeDefaultAut(), flk: { amt: 1, audio: false } };
    vi.spyOn(Math, 'random').mockReturnValue(0); // always below threshold
    animateLandscapeDeck(landscape, aut, 0, 1, 0.016);
    expect(landscape.scene.visible).toBe(false);
    Math.random.mockReturnValue(0.99);
    animateLandscapeDeck(landscape, aut, 0, 1, 0.016);
    expect(landscape.scene.visible).toBe(true);
  });
});

const makeSlotUniforms = () => ({
  mix: { value: 1 },
  scale: { value: 1 },
  fx: {
    value: {
      x: 0, y: 1, z: 0, w: 1,
      set(x, y, z, w) { Object.assign(this, { x, y, z, w }); },
      copy(v) { Object.assign(this, { x: v.x, y: v.y, z: v.z, w: v.w }); },
    },
  },
  warp: { value: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } } },
});

const makeBase = () => ({ mix: 0.8, scale: 1.5, fx: { x: 0.2, y: 1.1, z: 0.3, w: 0.9 } });

describe('channel position offsets', () => {
  it('pans and raises the landscape camera, translating rather than turning', () => {
    const landscape = makeLandscape({ camHeight: 2 });
    animateLandscapeDeck(landscape, makeDefaultAut(), 0, 1, 0.016, { x: 1.5, y: 0.5 });
    expect(landscape.camera.position.x).toBeCloseTo(1.5, 0);
    expect(landscape.camera.position.y).toBeGreaterThan(2.3);
    // lookAt target pans with the camera so the horizon stays ahead
    expect(landscape.camera.lookAt).toHaveBeenCalledWith(1.5, expect.any(Number), -6);
  });

  it('never lets the landscape camera dive under the terrain', () => {
    const landscape = makeLandscape({ camHeight: 2 });
    animateLandscapeDeck(landscape, makeDefaultAut(), 0, 1, 0.016, { x: 0, y: -2 });
    expect(landscape.camera.position.y).toBeGreaterThanOrEqual(0.1);
  });

  it('offsets a model group without touching its rotation animation', () => {
    const model = {
      group: {
        position: { x: 0, y: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { set: vi.fn() },
        visible: true,
      },
      baseScale: 1,
      spin: 0,
    };
    animateModelDeck(model, makeDefaultAut(), 0, 1, 0.016, { x: -1, y: 0.7 });
    expect(model.group.position).toMatchObject({ x: -1, y: 0.7 });
    expect(model.group.rotation.y).not.toBe(0);
  });

  it('offsets a sprite while keeping its idle bob', () => {
    const sprite = {
      mesh: {
        position: { x: 0, y: 0 },
        rotation: { z: 0 },
        scale: { set: vi.fn() },
        material: { uniforms: { u_time: { value: 0 }, u_opacity: { value: 1 }, u_distort: { value: 0 }, u_skew: { value: 0 } } },
      },
      baseW: 1,
      baseH: 1,
      spin: 0,
    };
    animateSpriteDeck(sprite, makeDefaultAut(), 0, 1, 0.016, { x: 0.5, y: -0.5 });
    expect(sprite.mesh.position.x).toBe(0.5);
    expect(sprite.mesh.position.y).toBeCloseTo(-0.5 + Math.sin(0.8) * 0.04);
  });
});

describe('animateShaderComposite', () => {
  it('idle automation lands exactly on the knob-set base values', () => {
    const uniforms = makeSlotUniforms();
    const base = makeBase();
    animateShaderComposite(uniforms, base, { spin: 0 }, makeDefaultAut(), 1, 2, 0.016);

    expect(uniforms.scale.value).toBeCloseTo(1.5);
    expect(uniforms.mix.value).toBeCloseTo(0.8);
    expect(uniforms.fx.value).toMatchObject({ x: 0.2, y: 1.1, z: 0.3, w: 0.9 });
    expect(uniforms.warp.value).toMatchObject({ x: 0, y: 0 });
  });

  it('SCL pulses the zoom around the base scale', () => {
    const uniforms = makeSlotUniforms();
    const aut = { ...makeDefaultAut(), scl: { amt: 1, audio: true } };
    animateShaderComposite(uniforms, makeBase(), { spin: 0 }, aut, 1, 2, 0.016);
    expect(uniforms.scale.value).toBeCloseTo(1.5 * 1.4);
  });

  it('ROT accumulates spin on top of the TILT knob', () => {
    const uniforms = makeSlotUniforms();
    const base = makeBase();
    const state = { spin: 0 };
    const aut = { ...makeDefaultAut(), rot: { amt: 1, audio: false } };
    animateShaderComposite(uniforms, base, state, aut, 0, 2, 0.1);
    animateShaderComposite(uniforms, base, state, aut, 0, 2.1, 0.1);
    expect(state.spin).toBeCloseTo(0.32);
    expect(uniforms.fx.value.x).toBeCloseTo(base.fx.x + 0.32);
    expect(base.fx.x).toBeCloseTo(0.2); // base never mutated
  });

  it('FLK dips brightness below the fader value', () => {
    const uniforms = makeSlotUniforms();
    const aut = { ...makeDefaultAut(), flk: { amt: 1, audio: false } };
    vi.spyOn(Math, 'random').mockReturnValue(1);
    animateShaderComposite(uniforms, makeBase(), { spin: 0 }, aut, 0, 2, 0.016);
    expect(uniforms.mix.value).toBe(0);
    Math.random.mockReturnValue(0);
    animateShaderComposite(uniforms, makeBase(), { spin: 0 }, aut, 0, 2, 0.016);
    expect(uniforms.mix.value).toBeCloseTo(0.8);
  });

  it('DST and SKW drive the composite warp uniform', () => {
    const uniforms = makeSlotUniforms();
    const aut = { ...makeDefaultAut(), dst: { amt: 1, audio: true }, skw: { amt: 1, audio: true } };
    animateShaderComposite(uniforms, makeBase(), { spin: 0 }, aut, 1, 2, 0.016);
    expect(uniforms.warp.value.x).toBeCloseTo(1);
    expect(uniforms.warp.value.y).toBeCloseTo(0.7);
  });
});

describe('resetShaderComposite', () => {
  it('pins composite params back to base and zeroes the warp', () => {
    const uniforms = makeSlotUniforms();
    uniforms.scale.value = 9;
    uniforms.mix.value = 0;
    uniforms.warp.value.set(1, 1);
    resetShaderComposite(uniforms, makeBase());
    expect(uniforms.scale.value).toBe(1.5);
    expect(uniforms.mix.value).toBe(0.8);
    expect(uniforms.fx.value.x).toBeCloseTo(0.2);
    expect(uniforms.warp.value).toMatchObject({ x: 0, y: 0 });
  });
});

describe('applyLightRig', () => {
  const makeRig = () => ({
    ambient: { intensity: 0 },
    key: { intensity: 0, position: { set(x, y, z) { Object.assign(this, { x, y, z }); }, x: 0, y: 0, z: 0 } },
    rim: { intensity: 0 },
    ambientBase: 0.5,
    keyBase: 1.6,
    rimBase: 1.2,
    keyRadius: Math.hypot(2, 4),
    keyBaseAngle: Math.atan2(2, 4),
    keyHeight: 3,
  });

  it('brightness 1 / angle 0 reproduces the built-in rig exactly', () => {
    const rig = makeRig();
    applyLightRig(rig, { brightness: 1, angle: 0 });
    expect(rig.ambient.intensity).toBeCloseTo(0.5);
    expect(rig.key.intensity).toBeCloseTo(1.6);
    expect(rig.rim.intensity).toBeCloseTo(1.2);
    expect(rig.key.position.x).toBeCloseTo(2);
    expect(rig.key.position.y).toBeCloseTo(3);
    expect(rig.key.position.z).toBeCloseTo(4);
  });

  it('brightness scales every light; 0 is a blackout', () => {
    const rig = makeRig();
    applyLightRig(rig, { brightness: 2, angle: 0 });
    expect(rig.key.intensity).toBeCloseTo(3.2);
    expect(rig.rim.intensity).toBeCloseTo(2.4);
    applyLightRig(rig, { brightness: 0, angle: 0 });
    expect(rig.ambient.intensity).toBe(0);
    expect(rig.key.intensity).toBe(0);
  });

  it('angle orbits the key light at constant radius and height', () => {
    const rig = makeRig();
    applyLightRig(rig, { brightness: 1, angle: Math.PI }); // opposite side
    expect(rig.key.position.x).toBeCloseTo(-2);
    expect(rig.key.position.z).toBeCloseTo(-4);
    expect(rig.key.position.y).toBeCloseTo(3); // elevation untouched
    expect(Math.hypot(rig.key.position.x, rig.key.position.z)).toBeCloseTo(rig.keyRadius);
  });
});
