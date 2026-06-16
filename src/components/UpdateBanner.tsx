import type { UpdaterState } from '../hooks/useUpdater';

interface Props {
  state: UpdaterState;
  onInstall: () => void;
  onDismiss: () => void;
}

// A non-blocking banner pinned bottom-center: shown when a newer version is
// available, while it downloads, or if an install/manual-check failed. The
// silent boot check stays invisible until there's something to act on.
export function UpdateBanner({ state, onInstall, onDismiss }: Props) {
  const { phase, info, progress, error } = state;
  if (phase !== 'available' && phase !== 'downloading' && phase !== 'error') return null;

  return (
    <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div className="w-96 rounded-lg border border-neutral-700 bg-neutral-900/95 px-4 py-3 shadow-xl">
        {phase === 'error' ? (
          <>
            <div className="mb-1 text-[11px] font-semibold text-rose-300">Update failed</div>
            <div className="mb-2 max-h-20 overflow-auto text-[10px] text-neutral-400">{error}</div>
            <div className="flex justify-end">
              <button
                onClick={onDismiss}
                className="rounded bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-neutral-200 hover:bg-neutral-700"
              >
                Dismiss
              </button>
            </div>
          </>
        ) : phase === 'downloading' ? (
          <>
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold text-neutral-200">
              <span>Downloading update…</span>
              <span className="tabular-nums text-neutral-400">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-cyan-500 transition-[width] duration-150"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div className="mt-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
              The app will relaunch when ready
            </div>
          </>
        ) : (
          <>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-cyan-300">
                Update available — v{info?.version}
              </span>
            </div>
            {info?.notes && (
              <div className="mb-2 max-h-24 overflow-auto whitespace-pre-line text-[10px] text-neutral-400">
                {info.notes}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={onDismiss}
                className="rounded bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-neutral-300 hover:bg-neutral-700"
              >
                Later
              </button>
              <button
                onClick={onInstall}
                className="rounded bg-cyan-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-cyan-500"
              >
                Install &amp; Relaunch
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
