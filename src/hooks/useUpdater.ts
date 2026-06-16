import { useCallback, useEffect, useRef, useState } from 'react';
import { getPlatform, type UpdateInfo } from '../platform';

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'error';

export interface UpdaterState {
  phase: UpdatePhase;
  /** The offered update once one is found. */
  info: UpdateInfo | null;
  /** Download progress 0..1 while installing. */
  progress: number;
  /** Last error message, if a check or install failed. */
  error: string | null;
}

// In-app autoupdate. On boot it silently asks the update endpoint; if a newer
// version exists it surfaces it (the UI shows a banner) without interrupting.
// install() downloads, applies, and relaunches — the process restarts, so this
// hook never resolves past it in practice.
export function useUpdater(opts?: { silentOnMount?: boolean }) {
  // The main app checks silently (a banner only appears if there's an update);
  // the Updates window checks visibly so it can show "Checking…"/"Up to date".
  const silentOnMount = opts?.silentOnMount ?? true;
  const [state, setState] = useState<UpdaterState>({
    phase: 'idle',
    info: null,
    progress: 0,
    error: null,
  });
  // The platform updater holds the pending Update internally; we only guard
  // against overlapping checks/installs here.
  const busy = useRef(false);

  const check = useCallback(async (silent: boolean) => {
    if (busy.current) return;
    busy.current = true;
    if (!silent) setState((s) => ({ ...s, phase: 'checking', error: null }));
    try {
      const info = await getPlatform().updater.check();
      setState((s) =>
        info
          ? { ...s, phase: 'available', info, error: null }
          : { ...s, phase: 'idle', info: null },
      );
    } catch (err) {
      // Update checks fail silently (offline, endpoint down, etc.) — never
      // surface an error. A manual check that was showing "Checking…" just
      // falls back to idle; a silent boot check was already invisible.
      console.error('[Vizzy] Update check failed:', err);
      setState((s) => (s.phase === 'checking' ? { ...s, phase: 'idle' } : s));
    } finally {
      busy.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setState((s) => ({ ...s, phase: 'downloading', progress: 0, error: null }));
    try {
      await getPlatform().updater.install((fraction) =>
        setState((s) => ({ ...s, progress: fraction })),
      );
      // On success the app relaunches; we don't get here.
    } catch (err) {
      console.error('[Vizzy] Update install failed:', err);
      setState((s) => ({ ...s, phase: 'error', error: String(err) }));
      busy.current = false;
    }
  }, []);

  const dismiss = useCallback(
    () => setState((s) => ({ ...s, phase: 'idle', error: null })),
    [],
  );

  // Check on mount. A no-op in the browser host (updater.check → null).
  useEffect(() => {
    void check(silentOnMount);
  }, [check, silentOnMount]);

  return {
    state,
    /** Manual check (from the File menu) — surfaces "up to date" and errors. */
    checkNow: () => check(false),
    install,
    dismiss,
  };
}
