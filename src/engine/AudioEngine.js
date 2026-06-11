const FFT_SIZE = 512;
const SMOOTHING = 0.15; // lerp factor per frame — raw FFT is too jittery for visuals

const BANDS = {
  low: [20, 250],
  mid: [250, 2000],
  high: [2000, 8000],
};

export class AudioEngine {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.stream = null;
    this.bins = null;
    this.smoothed = { low: 0, mid: 0, high: 0, level: 0 };
  }

  get active() {
    return Boolean(this.analyser);
  }

  async start(deviceId) {
    await this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    this.context = new AudioContext();
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0; // we do our own lerp in update()
    source.connect(this.analyser);
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
  }

  async stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this.analyser = null;
    this.bins = null;
  }

  async listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  bandAverage(fromHz, toHz) {
    const binHz = this.context.sampleRate / FFT_SIZE;
    const start = Math.max(0, Math.floor(fromHz / binHz));
    const end = Math.min(this.bins.length - 1, Math.ceil(toHz / binHz));
    let sum = 0;
    for (let i = start; i <= end; i += 1) sum += this.bins[i];
    const count = end - start + 1;
    return count > 0 ? sum / count / 255 : 0;
  }

  // Called once per animation frame; returns lerp-smoothed 0..1 band values.
  update() {
    const target = { low: 0, mid: 0, high: 0, level: 0 };
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this.bins);
      target.low = Math.min(1, this.bandAverage(...BANDS.low) * 1.4);
      target.mid = Math.min(1, this.bandAverage(...BANDS.mid) * 1.4);
      target.high = Math.min(1, this.bandAverage(...BANDS.high) * 1.4);
      target.level = Math.min(1, this.bandAverage(20, 16000) * 1.4);
    }
    const s = this.smoothed;
    s.low += (target.low - s.low) * SMOOTHING;
    s.mid += (target.mid - s.mid) * SMOOTHING;
    s.high += (target.high - s.high) * SMOOTHING;
    s.level += (target.level - s.level) * SMOOTHING;
    return s;
  }
}
