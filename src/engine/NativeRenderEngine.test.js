import { describe, it, expect, vi, beforeEach } from 'vitest';

// The IPC boundary is mocked; these tests pin the render_state contract the
// self-driving Rust engine consumes, the coalesced flush behavior, and the
// staging result mapping that feeds the LLM repair loop.
const invoke = vi.fn(async () => {});
const listen = vi.fn(async () => () => {});

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args) => listen(...args) }));

const { NativeRenderEngine } = await import('./NativeRenderEngine');

const makeEngine = () =>
  new NativeRenderEngine({ a: null, b: null }, [null, null, null, null]);

const stateCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'render_state');

beforeEach(() => {
  invoke.mockClear();
  vi.useFakeTimers();
});

describe('render_state payload', () => {
  it('mirrors knob setters into the slot state', () => {
    const engine = makeEngine();
    engine.setOpacity(2, 0.8);
    engine.setScale(2, 1.5);
    engine.setSize(2, 0.6, 0.4);
    engine.setChannelFx(2, 0.1, 1.2, -0.3, 0.9);
    engine.setLayer(2, 2);
    engine.setPosition(2, 0.5, -0.5);
    engine.setLighting(2, 1.4, 0.7);
    engine.setAudioRouting(2, 'high', 2);
    engine.setCrossfade(0.25);
    engine.setBpm(140);
    engine.setCueScene(1);

    const state = engine.statePayload();
    expect(state.xfade).toBe(0.25);
    expect(state.bpm).toBe(140);
    expect(state.cueScene).toBe(1);
    expect(state.slots).toHaveLength(8);
    expect(state.slots[2]).toMatchObject({
      mix: 0.8,
      scale: 1.5,
      sizeX: 0.6,
      sizeY: 0.4,
      tilt: 0.1,
      contrast: 1.2,
      hue: -0.3,
      sat: 0.9,
      layer: 2,
      posX: 0.5,
      posY: -0.5,
      brightness: 1.4,
      lightAngle: 0.7,
      band: 'high',
      amt: 2,
    });
    engine.dispose();
  });

  it('carries the render-resolution cap, defaulting to uncapped', () => {
    const engine = makeEngine();
    expect(engine.statePayload()).toMatchObject({ renderMaxW: 0, renderMaxH: 0 });
    engine.setRenderCap(1280, 720);
    expect(engine.statePayload()).toMatchObject({ renderMaxW: 1280, renderMaxH: 720 });
    engine.setRenderCap(0, 0);
    expect(engine.statePayload()).toMatchObject({ renderMaxW: 0, renderMaxH: 0 });
    engine.dispose();
  });

  it('passes loops and AUT config through verbatim', () => {
    const engine = makeEngine();
    const loop = {
      playing: true,
      blocks: 2,
      divider: 4,
      lanes: { opacity: [{ t: 0, v: 1, bend: 0 }] },
    };
    const aut = {
      scl: { amt: 0.5, audio: true },
      rot: { amt: 0, audio: false },
      tlt: { amt: 0, audio: false },
      flk: { amt: 0, audio: false },
      dst: { amt: 0, audio: false },
      skw: { amt: 0, audio: false },
    };
    engine.setLoop(1, loop);
    engine.setAutomation(1, aut);

    const state = engine.statePayload();
    expect(state.slots[1].loop).toBe(loop);
    expect(state.slots[1].aut).toBe(aut);
    engine.dispose();
  });

  it('coalesces a burst of setter calls into one push', async () => {
    const engine = makeEngine();
    invoke.mockClear(); // drop render_start + constructor flush
    vi.advanceTimersByTime(50);
    invoke.mockClear();

    engine.setOpacity(0, 1);
    engine.setOpacity(1, 0.5);
    engine.setCrossfade(0.7);
    expect(stateCalls()).toHaveLength(0); // nothing until the flush timer
    vi.advanceTimersByTime(20);
    expect(stateCalls()).toHaveLength(1);
    expect(stateCalls()[0][1].state.xfade).toBe(0.7);

    vi.advanceTimersByTime(100); // no further pushes while clean
    expect(stateCalls()).toHaveLength(1);
    engine.dispose();
  });
});

describe('staging', () => {
  it('stagePatch maps invoke rejection to a StageResult error', async () => {
    const engine = makeEngine();
    invoke.mockImplementationOnce(async () => {
      throw 'Unknown generator "nope"';
    });
    const result = await engine.stagePatch(0, { generator: 'nope' });
    expect(result).toEqual({ ok: false, error: 'Unknown generator "nope"' });
    engine.dispose();
  });

  it('stagePatch success records the patch and source', async () => {
    const engine = makeEngine();
    const patch = { generator: 'tunnel', palette: { preset: 'synthwave' } };
    const result = await engine.stagePatch(3, patch);
    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('render_stage_patch', { slot: 3, spec: patch });
    expect(engine.getPatch(3)).toEqual(patch);
    expect(engine.getChannelSource(3)).toEqual({ type: 'shader', patch });
    engine.dispose();
  });

  it('asset staging records sources by id', async () => {
    const engine = makeEngine();
    invoke.mockImplementationOnce(async () => ({ width: 10, height: 10 }));
    await engine.stageSpriteFromPath(0, '/tmp/a.png', 'sprite-9');
    expect(engine.getChannelSource(0)).toEqual({ type: 'sprite', spriteId: 'sprite-9' });
    await engine.stageModelFromPath(1, '/tmp/m.glb', 'model-9');
    expect(engine.getChannelSource(1)).toEqual({ type: 'model', modelId: 'model-9' });
    invoke.mockImplementationOnce(async () => ({ span: 9, camHeight: 1 }));
    await engine.stageLandscapeFromPath(2, '/tmp/t.glb', 'model-8');
    expect(engine.getChannelSource(2)).toEqual({ type: 'landscape', modelId: 'model-8' });
    engine.dispose();
  });

  it('stageSceneSpec sends generated buffers, fly mode and fog color', async () => {
    const engine = makeEngine();
    invoke.mockClear();
    invoke.mockImplementationOnce(async () => ({ span: 20, camHeight: 0 }));
    const spec = {
      kind: 'tunnel',
      surface: 'sin(a * 4)',
      amplitude: 2,
      palette: ['#1a0533', '#05ffa1', '#336699'],
    };
    const result = await engine.stageSceneSpec(5, spec);
    expect(result).toEqual({ ok: true });

    const [cmd, args] = invoke.mock.calls[0];
    expect(cmd).toBe('render_stage_scene');
    expect(args.slot).toBe(5);
    expect(args.fly).toBe('through');
    expect(args.positions.length).toBeGreaterThan(0);
    expect(args.colors.length).toBe(args.positions.length);
    expect(args.indices.length).toBeGreaterThan(0);
    expect(args.fogColor[0]).toBeCloseTo(0x33 / 255);
    expect(args.fogColor[1]).toBeCloseTo(0x66 / 255);
    expect(args.fogColor[2]).toBeCloseTo(0x99 / 255);
    expect(engine.getChannelSource(5)).toEqual({ type: 'scene', spec });
    engine.dispose();
  });

  it('an uncompilable scene spec fails cleanly without an IPC call', async () => {
    const engine = makeEngine();
    invoke.mockClear();
    const result = await engine.stageSceneSpec(0, {
      kind: 'terrain',
      surface: 'nonsense(z)',
      amplitude: 1,
      palette: ['#000000', '#ffffff', '#888888'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown function/);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'render_stage_scene')).toHaveLength(0);
    engine.dispose();
  });
});
