// Live audio metering. Drives the one per-frame `NativeAudioEngine.update()`
// loop (nothing else calls it) and publishes the smoothed bands, beat envelope,
// detected tempo, and each deck's post-routing value through a tiny external
// store — so only the meter widgets re-render at frame rate, not the whole App.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import type { NativeAudioEngine } from '../engine/NativeAudioEngine';
import type { AudioBand, AudioLevels, ChannelFx } from '../types';

export interface AudioMeters {
  low: number;
  mid: number;
  high: number;
  level: number;
  /** combined onset envelope 0..1 (max of enabled layers) */
  beat: number;
  /** per-layer onset envelopes 0..1 (kick / snare / hat) */
  beatLow: number;
  beatMid: number;
  beatHigh: number;
  /** detected tempo in BPM; 0 until enough onsets */
  bpm: number;
  bpmStable: boolean;
  /** per-deck value reaching the visual: min(1, selectedBand * amt) */
  deckLevels: number[];
}

const ZERO: AudioMeters = {
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
  deckLevels: [],
};

// TS twin of evaluate.rs `route_audio`'s source selection — keep in lockstep.
function bandValue(m: AudioLevels, band: AudioBand): number {
  switch (band) {
    case 'low':
      return m.low;
    case 'mid':
      return m.mid;
    case 'high':
      return m.high;
    case 'beat':
      return m.beat;
    case 'beat-low':
      return m.beatLow;
    case 'beat-mid':
      return m.beatMid;
    case 'beat-high':
      return m.beatHigh;
    default:
      return m.level;
  }
}

export interface MeterStore {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => AudioMeters;
}

/**
 * Start the per-frame meter loop and return a store the meter widgets read via
 * {@link useMeters}. `fx` supplies each deck's current band/amt for the
 * post-routing readout; it is tracked through a ref so the loop stays stable.
 */
export function useAudioMeters(
  audioRef: RefObject<NativeAudioEngine | null>,
  fx: ChannelFx[],
): MeterStore {
  const snapshotRef = useRef<AudioMeters>(ZERO);
  const listenersRef = useRef(new Set<() => void>());
  const fxRef = useRef(fx);
  fxRef.current = fx;

  const subscribe = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);
  const getSnapshot = useCallback(() => snapshotRef.current, []);

  useEffect(() => {
    let raf = 0;
    let frame = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const engine = audioRef.current;
      if (!engine) return;
      // Advance the smoother every frame (the lerp assumes per-frame steps)…
      const m = engine.update();
      // …but only publish ~30fps to keep React churn down.
      if ((frame++ & 1) !== 0) return;
      const deckLevels = fxRef.current.map((d) => Math.min(1, bandValue(m, d.band) * d.amt));
      snapshotRef.current = {
        low: m.low,
        mid: m.mid,
        high: m.high,
        level: m.level,
        beat: m.beat,
        beatLow: m.beatLow,
        beatMid: m.beatMid,
        beatHigh: m.beatHigh,
        bpm: m.bpm,
        bpmStable: m.bpmStable,
        deckLevels,
      };
      listenersRef.current.forEach((cb) => cb());
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioRef]);

  return useMemo(() => ({ subscribe, getSnapshot }), [subscribe, getSnapshot]);
}

/** Subscribe a single widget to the meter store without re-rendering its parents. */
export function useMeters(store: MeterStore): AudioMeters {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
