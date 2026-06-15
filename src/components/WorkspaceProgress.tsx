import type { ExportProgress } from '../lib/workspaceIO';

const LABELS: Record<ExportProgress['phase'], string> = {
  reading: 'Collecting assets',
  packing: 'Compressing',
  writing: 'Writing file',
};

// A small fixed overlay shown while a workspace is being saved. The reading
// phase is determinate (assets read / total); packing and writing block the
// main thread briefly, so they show an indeterminate sweep instead.
export function WorkspaceProgress({ progress }: { progress: ExportProgress | null }) {
  if (!progress) return null;
  const { phase, done, total } = progress;
  const determinate = phase === 'reading' && total > 0;
  const pct = determinate ? Math.round((done / total) * 100) : 100;
  const label = phase === 'reading' && total > 0 ? `${LABELS.reading} ${done}/${total}` : LABELS[phase];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div className="w-72 rounded-lg border border-neutral-700 bg-neutral-900/95 px-4 py-3 shadow-xl">
        <div className="mb-2 flex items-center justify-between text-[11px] font-semibold text-neutral-200">
          <span>Saving workspace…</span>
          {determinate && <span className="tabular-nums text-neutral-400">{pct}%</span>}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full rounded-full bg-cyan-500 transition-[width] duration-150 ${
              determinate ? '' : 'animate-pulse'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1.5 text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      </div>
    </div>
  );
}
