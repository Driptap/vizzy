import { useEffect, useState } from 'react';
import { getPlatform } from '../platform';
import { useUpdater } from '../hooks/useUpdater';

// The standalone Updates window (opened from the tray / menu bar). Shows the
// running version, the result of an update check, and an install button. Reuses
// useUpdater — but checks visibly on mount so it can report "up to date".
export function UpdaterWindow() {
  const updater = useUpdater({ silentOnMount: false });
  const [version, setVersion] = useState('…');
  useEffect(() => {
    void getPlatform().appVersion().then(setVersion);
  }, []);

  const { phase, info, progress, error } = updater.state;
  const checking = phase === 'checking';
  const downloading = phase === 'downloading';
  const available = phase === 'available';

  return (
    <div className="flex h-screen flex-col bg-neutral-950 px-6 py-5 text-neutral-200">
      <div className="text-sm font-black tracking-widest text-cyan-400">VIZZY</div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-neutral-500">
        Current version
      </div>
      <div className="text-2xl font-bold tabular-nums">v{version}</div>

      <div className="mt-5 flex-1">
        {checking && <p className="text-sm text-neutral-400">Checking for updates…</p>}

        {phase === 'idle' && !checking && (
          <p className="text-sm text-emerald-400">You're up to date.</p>
        )}

        {available && (
          <div>
            <p className="text-sm font-semibold text-cyan-300">
              Update available — v{info?.version}
            </p>
            {info?.notes && (
              <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-line rounded bg-neutral-900 p-2 text-[11px] text-neutral-400">
                {info.notes}
              </pre>
            )}
          </div>
        )}

        {downloading && (
          <div>
            <div className="mb-2 flex items-center justify-between text-sm text-neutral-300">
              <span>Downloading…</span>
              <span className="tabular-nums text-neutral-500">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-cyan-500 transition-[width] duration-150"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-neutral-500">The app will relaunch when ready.</p>
          </div>
        )}

        {phase === 'error' && (
          <div>
            <p className="text-sm font-semibold text-rose-300">Update failed</p>
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-line rounded bg-neutral-900 p-2 text-[11px] text-neutral-400">
              {error}
            </pre>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={updater.checkNow}
          disabled={checking || downloading}
          className="rounded bg-neutral-800 px-3 py-1.5 text-[12px] font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check Again'}
        </button>
        <button
          onClick={updater.install}
          disabled={!available || downloading}
          className="rounded bg-cyan-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-cyan-500 disabled:opacity-40"
        >
          Install &amp; Relaunch
        </button>
      </div>
    </div>
  );
}
