import { useEffect } from 'react';
import { useMeters, type MeterStore } from '../hooks/useAudioMeters';

interface Props {
  store: MeterStore;
  /** when false, detected tempo is advisory only (never written to the knob) */
  enabled: boolean;
  applyBpm: (bpm: number) => void;
}

/**
 * Drives the global BPM from the detected tempo when sync is on. Renders
 * nothing, so the frame-rate meter updates it subscribes to don't re-render the
 * App tree. Applies only on a *stable* estimate and only when the rounded value
 * changes, so the knob can't jitter or fight a manual edit between beats.
 */
export function BpmSyncBridge({ store, enabled, applyBpm }: Props): null {
  const { bpm, bpmStable } = useMeters(store);
  const rounded = Math.round(bpm);
  useEffect(() => {
    if (!enabled || !bpmStable || rounded <= 0) return;
    applyBpm(rounded);
  }, [enabled, bpmStable, rounded, applyBpm]);
  return null;
}
