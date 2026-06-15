// Tauri-native audio analysis: the Rust core (cpal + rustfft) captures input
// and emits raw WebAudio-style band averages; this class applies the same
// per-render-frame gain and lerp the WebAudio AudioEngine does, so visuals
// respond identically on both hosts.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AudioLevels, BeatBandConfig } from '../types';

const SMOOTHING = 0.15; // matches AudioEngine — lerp factor per frame

interface NativeAudioDevice {
  id: string;
  label: string;
}

const zero = (): AudioLevels => ({
  low: 0,
  mid: 0,
  high: 0,
  level: 0,
  beat: 0,
  beatLow: 0,
  beatMid: 0,
  beatHigh: 0,
  bpm: 0,
  bpmStable: false,
});

export class NativeAudioEngine {
  private raw: AudioLevels = zero();
  private unlisten: UnlistenFn | null = null;
  private running = false;
  smoothed: AudioLevels = zero();

  get active(): boolean {
    return this.running;
  }

  async start(deviceId?: string): Promise<void> {
    await this.stop();
    this.unlisten = await listen<AudioLevels>('vizzy://audio-levels', (e) => {
      this.raw = e.payload;
    });
    try {
      await invoke('audio_start', { deviceId: deviceId || null });
    } catch (err) {
      this.unlisten();
      this.unlisten = null;
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    if (this.running) {
      this.running = false;
      await invoke('audio_stop').catch(() => {});
    }
    this.raw = zero();
  }

  // Live-tune the native beat detector — one config per layer [low, mid, high]
  // (enable, sensitivity, decay, min-gap, frequency range). Safe whether or not
  // capture is running; the analysis loop reads it every tick.
  async setBeatConfig(bands: BeatBandConfig[]): Promise<void> {
    await invoke('audio_set_beat_config', { config: { bands } }).catch(() => {});
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await invoke<NativeAudioDevice[]>('audio_list_devices');
    return devices.map(
      (d) =>
        ({
          deviceId: d.id,
          label: d.label,
          kind: 'audioinput',
          groupId: '',
        }) as MediaDeviceInfo,
    );
  }

  // Called once per animation frame; returns lerp-smoothed 0..1 band values
  // plus the beat envelope and detected tempo.
  update(): AudioLevels {
    const target = this.running
      ? {
          low: Math.min(1, this.raw.low * 1.4),
          mid: Math.min(1, this.raw.mid * 1.4),
          high: Math.min(1, this.raw.high * 1.4),
          level: Math.min(1, this.raw.level * 1.4),
        }
      : zero();
    const s = this.smoothed;
    s.low += (target.low - s.low) * SMOOTHING;
    s.mid += (target.mid - s.mid) * SMOOTHING;
    s.high += (target.high - s.high) * SMOOTHING;
    s.level += (target.level - s.level) * SMOOTHING;
    // Beat envelopes are already shaped in audio.rs: pass them through with NO
    // gain and NO lerp, mirroring the render evaluator (evaluate.rs). bpm/stable
    // likewise ride straight through for the meters and BPM-sync path.
    s.beat = this.running ? this.raw.beat : 0;
    s.beatLow = this.running ? this.raw.beatLow : 0;
    s.beatMid = this.running ? this.raw.beatMid : 0;
    s.beatHigh = this.running ? this.raw.beatHigh : 0;
    s.bpm = this.running ? this.raw.bpm : 0;
    s.bpmStable = this.running ? this.raw.bpmStable : false;
    return s;
  }
}
