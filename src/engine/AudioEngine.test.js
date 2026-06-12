import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioEngine } from './AudioEngine';

const FFT_SIZE = 512;
// sampleRate chosen so each FFT bin is exactly 100 Hz wide — band edges land
// on predictable bin indices
const SAMPLE_RATE = FFT_SIZE * 100;

class FakeAnalyser {
  constructor() {
    this.fftSize = 0;
    this.smoothingTimeConstant = -1;
    this.fillValue = 0;
  }

  get frequencyBinCount() {
    return this.fftSize / 2;
  }

  getByteFrequencyData(arr) {
    arr.fill(this.fillValue);
  }
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = SAMPLE_RATE;
    this.closed = false;
    this.analyser = new FakeAnalyser();
    this.source = { connect: vi.fn() };
  }

  createMediaStreamSource() {
    return this.source;
  }

  createAnalyser() {
    return this.analyser;
  }

  async close() {
    this.closed = true;
  }
}

const makeStream = () => {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] }, track };
};

let getUserMedia;

beforeEach(() => {
  const { stream } = makeStream();
  getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia, enumerateDevices: vi.fn() },
  });
});

describe('AudioEngine lifecycle', () => {
  it('is inactive until started', async () => {
    const engine = new AudioEngine();
    expect(engine.active).toBe(false);
    await engine.start();
    expect(engine.active).toBe(true);
  });

  it('configures the analyser and does its own smoothing', async () => {
    const engine = new AudioEngine();
    await engine.start();
    expect(engine.analyser.fftSize).toBe(FFT_SIZE);
    expect(engine.analyser.smoothingTimeConstant).toBe(0);
    expect(engine.context.source.connect).toHaveBeenCalledWith(engine.analyser);
    expect(engine.bins).toHaveLength(FFT_SIZE / 2);
  });

  it('requests a specific device with exact constraint, default otherwise', async () => {
    const engine = new AudioEngine();
    await engine.start();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    await engine.start('dev-7');
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'dev-7' } },
    });
  });

  it('stop releases the stream and context', async () => {
    const { stream, track } = makeStream();
    getUserMedia.mockResolvedValue(stream);
    const engine = new AudioEngine();
    await engine.start();
    const context = engine.context;

    await engine.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(context.closed).toBe(true);
    expect(engine.active).toBe(false);
    expect(engine.bins).toBeNull();
  });

  it('restarting stops the previous capture first', async () => {
    const first = makeStream();
    const second = makeStream();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const engine = new AudioEngine();
    await engine.start();
    await engine.start('other');
    expect(first.track.stop).toHaveBeenCalled();
    expect(second.track.stop).not.toHaveBeenCalled();
  });

  it('listDevices returns only audio inputs', async () => {
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'mic' },
      { kind: 'videoinput', deviceId: 'cam' },
      { kind: 'audiooutput', deviceId: 'speakers' },
    ]);
    const engine = new AudioEngine();
    expect(await engine.listDevices()).toEqual([{ kind: 'audioinput', deviceId: 'mic' }]);
  });
});

describe('AudioEngine analysis', () => {
  it('bandAverage averages the bins covering the requested range', async () => {
    const engine = new AudioEngine();
    await engine.start();
    // bins are 100 Hz wide: 20-250 Hz covers bins 0..3
    engine.bins.fill(0);
    engine.bins[0] = 255;
    engine.bins[1] = 255;
    engine.bins[2] = 0;
    engine.bins[3] = 0;
    expect(engine.bandAverage(20, 250)).toBeCloseTo(0.5);
  });

  it('bandAverage clamps the range to the available bins', async () => {
    const engine = new AudioEngine();
    await engine.start();
    engine.bins.fill(255);
    expect(engine.bandAverage(20, 1e9)).toBeCloseTo(1);
  });

  it('update lerps toward the measured level (never jumps)', async () => {
    const engine = new AudioEngine();
    await engine.start();
    engine.analyser.fillValue = 255; // full-scale signal -> target 1 in all bands

    const first = engine.update();
    expect(first.level).toBeCloseTo(0.15);
    const second = engine.update();
    expect(second.level).toBeCloseTo(0.15 + 0.85 * 0.15);
    expect(second.low).toBe(second.mid); // uniform spectrum, uniform bands
  });

  it('update decays toward zero when inactive', async () => {
    const engine = new AudioEngine();
    await engine.start();
    engine.analyser.fillValue = 255;
    engine.update();
    await engine.stop();

    const before = engine.smoothed.level;
    const after = engine.update();
    expect(after.level).toBeCloseTo(before * 0.85);
  });

  it('band values are clamped to 1 despite the 1.4 gain', async () => {
    const engine = new AudioEngine();
    await engine.start();
    engine.analyser.fillValue = 255;
    for (let i = 0; i < 100; i += 1) engine.update();
    expect(engine.smoothed.low).toBeLessThanOrEqual(1);
    expect(engine.smoothed.level).toBeCloseTo(1, 2);
  });
});
