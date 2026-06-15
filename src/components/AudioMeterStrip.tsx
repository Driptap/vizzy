import { useMeters, type MeterStore } from '../hooks/useAudioMeters';

const BARS: { key: 'low' | 'mid' | 'high'; color: string }[] = [
  { key: 'low', color: '#22d3ee' },
  { key: 'mid', color: '#a3e635' },
  { key: 'high', color: '#f472b6' },
];

interface Props {
  store: MeterStore;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Compact always-visible audio meter in the TopBar: three band bars, a beat
 * flash, and the detected BPM. The whole strip toggles the full panel. Reads
 * the meter store directly via {@link useMeters} so only this widget repaints
 * at frame rate.
 */
export function AudioMeterStrip({ store, expanded, onToggle }: Props) {
  const m = useMeters(store);
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Audio meters — bands, beat & detected BPM (click for the full panel)"
      className={`inline-flex items-center gap-2 rounded px-2 py-1 transition-colors ${
        expanded ? 'bg-cyan-600/30 ring-1 ring-cyan-500' : 'bg-neutral-800 hover:bg-neutral-700'
      }`}
    >
      <span className="flex h-4 items-end gap-0.5" aria-hidden>
        {BARS.map((b) => (
          <span
            key={b.key}
            className="w-1 rounded-sm"
            style={{ height: `${Math.max(8, m[b.key] * 100)}%`, background: b.color }}
          />
        ))}
      </span>
      <span
        aria-hidden
        className="h-2 w-2 rounded-full bg-red-500"
        style={{ opacity: 0.2 + m.beat * 0.8, transform: `scale(${0.7 + m.beat * 0.6})` }}
      />
      <span className="font-mono text-[11px] tabular-nums text-neutral-200">
        {m.bpm > 0 ? Math.round(m.bpm) : '--'}
        <span className="ml-0.5 text-[8px] text-neutral-500">BPM</span>
      </span>
    </button>
  );
}
