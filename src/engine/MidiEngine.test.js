import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MidiEngine } from './MidiEngine';

const STORAGE_KEY = 'vizzy.midiBindings';
const LEGACY_STORAGE_KEY = 'promptvj.midiBindings';

const ccMessage = (cc, value, status = 0xb0) => ({ data: [status, cc, value] });

const makeEngine = () => {
  const onControlValue = vi.fn();
  const onLearned = vi.fn();
  const engine = new MidiEngine({ onControlValue, onLearned });
  return { engine, onControlValue, onLearned };
};

describe('MidiEngine bindings persistence', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty with no stored bindings', () => {
    const { engine } = makeEngine();
    expect(engine.controlMap()).toEqual({});
  });

  it('loads bindings from storage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 21: 'xfade' }));
    const { engine } = makeEngine();
    expect(engine.controlMap()).toEqual({ xfade: 21 });
  });

  it('falls back to the pre-rebrand storage key', () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ 7: 'a_mix1' }));
    const { engine } = makeEngine();
    expect(engine.controlMap()).toEqual({ a_mix1: 7 });
  });

  it('survives corrupt stored JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not json{');
    const { engine } = makeEngine();
    expect(engine.controlMap()).toEqual({});
  });
});

describe('MidiEngine message handling', () => {
  it('normalizes CC values to 0..1 for bound controls', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 21: 'xfade' }));
    const { engine, onControlValue } = makeEngine();

    engine.handleMessage(ccMessage(21, 127));
    expect(onControlValue).toHaveBeenCalledWith('xfade', 1);
    engine.handleMessage(ccMessage(21, 0));
    expect(onControlValue).toHaveBeenCalledWith('xfade', 0);
  });

  it('ignores unbound CCs and non-CC messages', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 21: 'xfade' }));
    const { engine, onControlValue } = makeEngine();

    engine.handleMessage(ccMessage(99, 64)); // unbound CC
    engine.handleMessage(ccMessage(21, 64, 0x90)); // note-on, not CC
    expect(onControlValue).not.toHaveBeenCalled();
  });

  it('matches CC status on any channel', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 21: 'xfade' }));
    const { engine, onControlValue } = makeEngine();
    engine.handleMessage(ccMessage(21, 127, 0xb5)); // CC on channel 6
    expect(onControlValue).toHaveBeenCalledWith('xfade', 1);
  });
});

describe('MidiEngine learn flow', () => {
  it('binds the armed control to the next CC and persists it', () => {
    const { engine, onControlValue, onLearned } = makeEngine();

    engine.arm('a_mix2');
    engine.handleMessage(ccMessage(30, 64));

    expect(onLearned).toHaveBeenCalledWith('a_mix2', 30);
    expect(onControlValue).not.toHaveBeenCalled(); // the learning message is consumed
    expect(engine.armedControl).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toEqual({ 30: 'a_mix2' });

    engine.handleMessage(ccMessage(30, 127));
    expect(onControlValue).toHaveBeenCalledWith('a_mix2', 1);
  });

  it('re-learning a control drops its previous CC', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 10: 'xfade', 11: 'a_mix1' }));
    const { engine } = makeEngine();

    engine.arm('xfade');
    engine.handleMessage(ccMessage(42, 1));

    expect(engine.controlMap()).toEqual({ xfade: 42, a_mix1: 11 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toEqual({ 42: 'xfade', 11: 'a_mix1' });
  });

  it('disarm cancels a pending learn', () => {
    const { engine, onLearned, onControlValue } = makeEngine();
    engine.arm('xfade');
    engine.disarm();
    engine.handleMessage(ccMessage(42, 64));
    expect(onLearned).not.toHaveBeenCalled();
    expect(onControlValue).not.toHaveBeenCalled();
  });
});

describe('MidiEngine device wiring', () => {
  const makeAccess = () => {
    const inputs = new Map([
      ['in1', { onmidimessage: null }],
      ['in2', { onmidimessage: null }],
    ]);
    return { inputs, onstatechange: null };
  };

  it('init attaches the handler to every input and tracks state changes', async () => {
    const access = makeAccess();
    vi.stubGlobal('navigator', {
      ...navigator,
      requestMIDIAccess: vi.fn().mockResolvedValue(access),
    });
    const { engine } = makeEngine();
    await engine.init();

    expect(engine.inputCount).toBe(2);
    access.inputs.forEach((input) => expect(input.onmidimessage).toBe(engine.handleMessage));

    const added = { onmidimessage: null };
    access.inputs.set('in3', added);
    access.onstatechange();
    expect(added.onmidimessage).toBe(engine.handleMessage);
  });

  it('dispose detaches all handlers', async () => {
    const access = makeAccess();
    vi.stubGlobal('navigator', {
      ...navigator,
      requestMIDIAccess: vi.fn().mockResolvedValue(access),
    });
    const { engine } = makeEngine();
    await engine.init();
    engine.dispose();
    access.inputs.forEach((input) => expect(input.onmidimessage).toBeNull());
    expect(access.onstatechange).toBeNull();
  });

  it('inputCount is 0 before init', () => {
    const { engine } = makeEngine();
    expect(engine.inputCount).toBe(0);
  });
});
