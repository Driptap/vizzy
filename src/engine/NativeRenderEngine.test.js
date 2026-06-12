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

    const slots = engine.frame(0, 0.016);
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

    const slots = engine.frame(0, 0.016);
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

    const slots = engine.frame(0, 0.016);
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
    expect(engine.frame(0, 0.016)[0]).toBeCloseTo(0);

    engine.setLoop(0, null);
    expect(engine.frame(0.1, 0.016)[0]).toBeCloseTo(0.5);
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

  it('non-shader staging returns the Phase 3 stub error', async () => {
    const engine = makeEngine();
    const result = await engine.stageModel();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Phase 3/);
    engine.dispose();
  });
});
