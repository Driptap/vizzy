import { useCallback, useEffect, useRef } from 'react';
import { saveSession, saveSessionSync, loadSession } from '../lib/session';
import { stageSource, resolveSourceRef } from '../lib/sourceStaging';
import { SLOTS } from '../lib/channels';
import type { LibraryEntry, SessionSnapshot } from '../types';
import type { EngineRef } from './useEngineRig';
import type { PerformanceState } from './usePerformanceState';

interface SessionPersistenceOptions {
  engineRef: EngineRef;
  state: PerformanceState;
  setDeckState: PerformanceState['setDeckState'];
  setSourceType: PerformanceState['setSourceType'];
  restoreFromSession: PerformanceState['restoreFromSession'];
}

// Performance-session persistence: autosaves the whole mixer/deck state
// (debounced, with a sync last-gasp flush on close) and restores it on boot.
export function useSessionPersistence({
  engineRef,
  state,
  setDeckState,
  setSourceType,
  restoreFromSession,
}: SessionPersistenceOptions) {
  // gate saves until the initial restore has run, keep the latest snapshot
  // for the sync beforeunload flush
  const sessionReadyRef = useRef(false);
  const sessionSnapshotRef = useRef<SessionSnapshot | null>(null);
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const markSessionReady = useCallback(() => {
    sessionReadyRef.current = true;
  }, []);

  // Restore a saved session: re-stage every slot's content (shader code is
  // stored inline; models/sprites by library id) and put back all config.
  // Failures are logged, never fatal — the deck just stays on its default.
  // Awaits all staging so the caller can enable autosave only once the
  // sources are back; otherwise the debounced save would snapshot empty
  // channels and progressively drop sources from session.json.
  const restoreSession = useCallback(
    async (session: SessionSnapshot, entries: LibraryEntry[]) => {
      const engine = engineRef.current;
      if (!engine || !Array.isArray(session.slots)) return;
      const byId = new Map(entries.map((e) => [e.id, e]));

      restoreFromSession(session);

      await Promise.all(
        session.slots.slice(0, SLOTS).map(async (slot, i) => {
          const { source } = resolveSourceRef(slot.source || {}, byId);
          if (!source) return;
          const result = await stageSource(engine, i, source);
          if (result.ok) {
            setDeckState(i, 'active');
            setSourceType(i, source.type);
          } else {
            console.warn('[Vizzy] Session restore failed for slot', i, result.error);
          }
        }),
      );
    },
    [engineRef, setDeckState, setSourceType, restoreFromSession],
  );

  const loadSavedSession = useCallback(() => loadSession(), []);

  // Autosave: snapshot the whole performance state on any change, debounced
  // to disk; the latest snapshot is also flushed synchronously on app close.
  const { prompts, opacities, muted, scales, sizes, positions, lights, layers, loops, bpm, bpmSync, beatBands, fx, filters, aut, crossfade, cueScene, sourceTypes, decks } = state;
  useEffect(() => {
    if (!sessionReadyRef.current) return undefined;
    const engine = engineRef.current;
    const snapshot: SessionSnapshot = {
      version: 1,
      crossfade,
      cueScene,
      bpm,
      bpmSync,
      beatBands,
      slots: Array.from({ length: SLOTS }, (_, i) => ({
        source: engine ? engine.getChannelSource(i) : undefined,
        prompt: prompts[i],
        opacity: opacities[i],
        muted: muted[i],
        scale: scales[i],
        size: sizes[i],
        pos: positions[i],
        light: lights[i],
        layer: layers[i],
        loop: loops[i],
        fx: fx[i],
        filter: filters[i],
        aut: aut[i],
      })),
    };
    sessionSnapshotRef.current = snapshot;
    clearTimeout(sessionTimerRef.current);
    sessionTimerRef.current = setTimeout(() => {
      saveSession(snapshot).catch((err) => console.warn('[Vizzy] Session save failed:', err));
    }, 800);
    return () => clearTimeout(sessionTimerRef.current);
  }, [engineRef, prompts, opacities, muted, scales, sizes, positions, lights, layers, loops, bpm, bpmSync, beatBands, fx, filters, aut, crossfade, cueScene, sourceTypes, decks]);

  useEffect(() => {
    const flush = () => {
      if (sessionSnapshotRef.current) saveSessionSync(sessionSnapshotRef.current);
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  return { restoreSession, loadSavedSession, markSessionReady };
}
