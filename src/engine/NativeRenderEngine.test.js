import { describe, it, expect, vi, beforeEach } from 'vitest';

// The IPC boundary is mocked; these tests pin the params contract the Rust
// engine consumes: the 15-float slot layout, audio routing math, and loop
// override semantics.
const invoke = vi.fn(async () => {});
const listen = vi.fn(async () => () => {});

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args) => listen(...args) }));

const { NativeRenderEngine } = await import('./NativeRenderEngine');

const makeEngine = (audio = { low: 0, mid: 0, high: 0, level: 0 }) =>
  new NativeRenderEngine({ a: null, b: null }, [null, null, null, null], {
    update: () => audio,
  });

beforeEach(() => {
  invoke.mockClear();
});

describe('slot params layout', () => {
  it('packs knob values into the 15-float slot order', () => {
    const engine = makeEngine();
    engine.setOpacity(2, 0.8);
    engine.setScale(2, 1.5);
    engine.setSize(2, 0.6, 0.4);
    engine.setChannelFx(2, 0.1, 1.2, -0.3, 0.9);
    engine.setLayer(2, 2);

    const [slots] = engine.frame(0, 0.016);
    const o = 2 * 15;
    expect(slots[o]).toBeCloseTo(0.8); // mix
    expect(slots[o + 1]).toBeCloseTo(1.5); // scale (no AUT -> base)
    expect(slots[o + 2]).toBeCloseTo(0.6); // sizeX
    expect(slots[o + 3]).toBeCloseTo(0.4); // sizeY
    expect(slots[o + 4]).toBeCloseTo(0.1); // fx tilt
    expect(slots[o + 5]).toBeCloseTo(1.2); // fx contrast
    expect(slots[o + 6]).toBeCloseTo(-0.3); // fx hue
    expect(slots[o + 7]).toBeCloseTo(0.9); // fx sat
    expect(slots[o + 8]).toBe(0); // warp x (idle)
    expect(slots[o + 9]).toBe(0); // warp y
    expect(slots[o + 10]).toBe(2); // layer
    engine.dispose();
  });

  it('routes audio per deck: amt scales all bands, band drives level', () => {
    const engine = makeEngine({ low: 0.5, mid: 0.2, high: 0.9, level: 0.4 });
    engine.setAudioRouting(0, 'high', 2);
    engine.setAudioRouting(1, 'level', 0.5);

    const [slots] = engine.frame(0, 0.016);
    expect(slots[11]).toBe(1); // low 0.5*2 clamped
    expect(slots[12]).toBeCloseTo(0.4); // mid 0.2*2
    expect(slots[13]).toBe(1); // high 0.9*2 clamped
    expect(slots[14]).toBe(1); // level <- high band, 0.9*2 clamped

    const o = 15;
    expect(slots[o + 11]).toBeCloseTo(0.25);
    expect(slots[o + 14]).toBeCloseTo(0.2); // level band * 0.5
    engine.dispose();
  });
});

describe('loop overrides', () => {
  const flatLane = (v) => [
    { t: 0, v, bend: 0 },
    { t: 1, v, bend: 0 },
  ];

  it('fader lane multiplies the knob mix; scale lane lerps 0.25..3', () => {
    const engine = makeEngine();
    engine.setOpacity(0, 0.5);
    engine.setScale(0, 2);
    engine.setBpm(120);
    engine.setLoop(0, {
      playing: true,
      blocks: 1,
      divider: 4,
      lanes: { opacity: flatLane(0.5), scale: flatLane(1) },
    });

    const [slots] = engine.frame(0, 0.016);
    expect(slots[0]).toBeCloseTo(0.25); // 0.5 knob * 0.5 lane
    expect(slots[1]).toBeCloseTo(3); // lane 1 -> top of 0.25..3 range
    engine.dispose();
  });

  it('stopping the loop lands back on the knob values', () => {
    const engine = makeEngine();
    engine.setOpacity(0, 0.5);
    engine.setLoop(0, {
      playing: true,
      blocks: 1,
      divider: 4,
      lanes: { opacity: flatLane(0) },
    });
    expect(engine.frame(0, 0.016)[0][0]).toBeCloseTo(0);

    engine.setLoop(0, null);
    expect(engine.frame(0.1, 0.016)[0][0]).toBeCloseTo(0.5);
    engine.dispose();
  });
});

describe('deck ext block (Phase 3 content)', () => {
  it('shader decks write mode 0 and nothing else', () => {
    const engine = makeEngine();
    const [, decks] = engine.frame(0, 0.016);
    expect(decks[0]).toBe(0);
    expect(decks[16]).toBe(0);
    engine.dispose();
  });

  it('staged sprite writes mode 1 with the composed 2x2 matrix', async () => {
    const engine = makeEngine();
    invoke.mockImplementationOnce(async () => ({ width: 200, height: 100 })); // aspect 2
    await engine.stageSpriteFromPath(1, '/tmp/a.png', 'sprite-1');

    const viewAspect = 2;
    const [, decks] = engine.frame(0, 0.016, viewAspect);
    const o = 16;
    expect(decks[o]).toBe(1); // mode sprite
    // no AUT: rotation 0, mesh scale = base size; layout: h = min(1.7, 1.7*2/2)
    // = 1.7, baseW = 3.4, baseH = 1.7; container x-comp = 1/2
    expect(decks[o + 1]).toBeCloseTo(0.5 * 3.4); // m00 = cx*cos*sx
    expect(decks[o + 2]).toBeCloseTo(0); // m01
    expect(decks[o + 3]).toBeCloseTo(0); // m10
    expect(decks[o + 4]).toBeCloseTo(1.7); // m11 = cos*sy
    expect(decks[o + 9]).toBeCloseTo(1); // opacity, no flicker
    expect(decks[o + 10]).toBe(1); // visible
    engine.dispose();
  });

  it('staged model writes mode 2 with per-axis scale and light state', async () => {
    const engine = makeEngine();
    await engine.stageModelFromPath(2, '/tmp/m.glb', 'model-1');
    engine.setLighting(2, 1.5, 0.7);

    const [, decks] = engine.frame(1, 0.016);
    const o = 2 * 16;
    expect(decks[o]).toBe(2); // mode model
    expect(decks[o + 7]).toBeCloseTo(1, 1); // quaternion w ~ 1 (no spin yet)
    expect(decks[o + 8]).toBeCloseTo(1); // sclX (baseScale 1, no AUT)
    expect(decks[o + 12]).toBeCloseTo(1); // sclY
    expect(decks[o + 13]).toBeCloseTo(1); // sclZ
    expect(decks[o + 9]).toBeCloseTo(1.5); // brightness
    expect(decks[o + 10]).toBeCloseTo(0.7); // lightAngle
    expect(decks[o + 11]).toBe(1); // visible
    engine.dispose();
  });

  it('staged landscape writes mode 3 with camera and tile state', async () => {
    const engine = makeEngine();
    invoke.mockImplementationOnce(async () => ({ span: 9, camHeight: 1.2 }));
    await engine.stageLandscapeFromPath(3, '/tmp/terrain.glb', 'model-2');

    const [, decks] = engine.frame(0, 0.5); // dt advances the scroll
    const o = 3 * 16;
    expect(decks[o]).toBe(3); // mode flight
    expect(decks[o + 3]).toBeCloseTo(9 * 0.45); // camZ fixed at span*0.45
    // scroll = 0.5 * (9/9) * 1 = 0.5 -> tile z = (0.5 % 18) - 9
    expect(decks[o + 8]).toBeCloseTo(0.5 - 9); // tile1Z
    expect(decks[o + 9]).toBeCloseTo(9.5 - 9); // tile2Z
    expect(decks[o + 14]).toBe(64); // fov
    engine.dispose();
  });

  it('non-shader decks pin composite uniforms to the knobs (no spin)', async () => {
    const engine = makeEngine();
    await engine.stageModelFromPath(0, '/tmp/m.glb', 'model-1');
    engine.setScale(0, 1.4);
    engine.setAutomation(0, {
      scl: { amt: 1, audio: false },
      rot: { amt: 1, audio: false },
      tlt: { amt: 0, audio: false },
      flk: { amt: 0, audio: false },
      dst: { amt: 1, audio: false },
      skw: { amt: 0, audio: false },
    });
    const [slots] = engine.frame(1, 0.016);
    expect(slots[1]).toBeCloseTo(1.4); // scale pinned, AUT does not zoom-pulse
    expect(slots[8]).toBe(0); // no composite warp for in-scene decks
    engine.dispose();
  });

  it('getChannelSource reflects staged content', async () => {
    const engine = makeEngine();
    invoke.mockImplementationOnce(async () => ({ width: 10, height: 10 }));
    await engine.stageSpriteFromPath(0, '/tmp/a.png', 'sprite-9');
    expect(engine.getChannelSource(0)).toEqual({ type: 'sprite', spriteId: 'sprite-9' });
    await engine.stageModelFromPath(1, '/tmp/m.glb', 'model-9');
    expect(engine.getChannelSource(1)).toEqual({ type: 'model', modelId: 'model-9' });
    engine.dispose();
  });
});

describe('staging', () => {
  it('stageShader maps invoke rejection to a StageResult error', async () => {
    const engine = makeEngine();
    invoke.mockImplementationOnce(async () => {
      throw 'ERROR: unknown identifier `foo`';
    });
    const result = await engine.stageShader(0, 'void main() { foo; }');
    expect(result).toEqual({ ok: false, error: 'ERROR: unknown identifier `foo`' });
    engine.dispose();
  });

  it('stageShader success records the body for getShaderBody', async () => {
    const engine = makeEngine();
    const result = await engine.stageShader(3, 'void main() { gl_FragColor = vec4(1.0); }');
    expect(result).toEqual({ ok: true });
    expect(engine.getShaderBody(3)).toContain('vec4(1.0)');
    expect(engine.getChannelSource(3)).toEqual({
      type: 'shader',
      code: 'void main() { gl_FragColor = vec4(1.0); }',
    });
    engine.dispose();
  });

  it('failed asset staging keeps the previous channel source', async () => {
    const engine = makeEngine();
    invoke.mockImplementationOnce(async () => {
      throw 'unsupported model format .fbx';
    });
    const result = await engine.stageModelFromPath(0, '/tmp/m.fbx', 'model-1');
    expect(result).toEqual({ ok: false, error: 'unsupported model format .fbx' });
    expect(engine.getChannelSource(0).type).toBe('shader');
    engine.dispose();
  });
});
