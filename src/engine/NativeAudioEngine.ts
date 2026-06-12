// Tauri-native audio analysis: the Rust core (cpal + rustfft) captures input
// and emits raw WebAudio-style band averages; this class applies the same
// per-render-frame gain and lerp the WebAudio AudioEngine does, so visuals
// respond identically on both hosts.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AudioLevels } from '../types';

const SMOOTHING = 0.15; // matches AudioEngine — lerp factor per frame

interface NativeAudioDevice {
  id: string;
  label: string;
}

const zero = (): AudioLevels => ({ low: 0, mid: 0, high: 0, level: 0 });

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

  // Called once per animation frame; returns lerp-smoothed 0..1 band values.
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
    return s;
  }
}
