import { useState } from 'react';

const STATUS_STYLES = {
  idle: { label: 'Idle', className: 'bg-neutral-700 text-neutral-300' },
  queued: { label: 'Queued', className: 'bg-amber-500/20 text-amber-300' },
  generating: { label: 'Generating', className: 'bg-blue-500/20 text-blue-300 animate-pulse' },
  compiling: { label: 'Compiling', className: 'bg-purple-500/20 text-purple-300 animate-pulse' },
  active: { label: 'Active', className: 'bg-emerald-500/20 text-emerald-300' },
  failed: { label: 'Compile Failed', className: 'bg-red-500/20 text-red-300' },
  error: { label: 'Error', className: 'bg-red-500/20 text-red-300' },
};

const BUSY_STATUSES = ['queued', 'generating', 'compiling'];

export function DeckModule({
  index,
  sceneLetter,
  status,
  error,
  prompt,
  onPromptChange,
  scale,
  onScaleChange,
  size,
  onSizeChange,
  onGenerate,
  onSave,
  previewRef,
}) {
  const [saved, setSaved] = useState(false);
  const badge = STATUS_STYLES[status] || STATUS_STYLES.idle;
  const busy = BUSY_STATUSES.includes(status);

  const generate = () => {
    if (prompt.trim() && !busy) onGenerate(index, prompt.trim());
  };

  const save = async () => {
    await onSave(index);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold tracking-widest text-neutral-400">
          DECK{' '}
          <span className={sceneLetter === 'A' ? 'text-cyan-400' : 'text-fuchsia-400'}>
            {sceneLetter}
            {index + 1}
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={save}
            title="Save current shader to the library"
            className={`rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-wider transition-colors ${
              saved
                ? 'border-emerald-500 text-emerald-300'
                : 'border-neutral-700 text-neutral-400 hover:border-cyan-500 hover:text-cyan-300'
            }`}
          >
            {saved ? '✓' : 'SAVE'}
          </button>
          <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>
            {badge.label}
          </span>
        </div>
      </div>

      {/* width/height attrs are managed by RenderEngine to track the scene
          views' aspect. The DISPLAY box is fixed 16:9 with object-contain
          (letterboxed) — if display height followed the render aspect, tall
          aspects would grow the card, shrink the scene views above, and feed
          back into an even taller aspect until the layout collapsed. */}
      <canvas
        ref={previewRef}
        width={160}
        height={90}
        className="aspect-video w-full rounded border border-neutral-800 bg-black object-contain"
      />

      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-bold tracking-wider text-neutral-500">SCALE</span>
        <input
          type="range"
          min="0.25"
          max="3"
          step="0.05"
          value={scale}
          onChange={(e) => onScaleChange(index, Number(e.target.value))}
          onDoubleClick={() => onScaleChange(index, 1)}
          title="Deck zoom (double-click to reset)"
          className="h-1 min-w-0 flex-1 cursor-pointer accent-cyan-500"
          aria-label={`Deck ${index + 1} scale`}
        />
        <span className="w-9 text-right font-mono text-[9px] text-neutral-400">
          {scale.toFixed(2)}x
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        {['x', 'y'].map((axis) => (
          <div key={axis} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-[9px] font-bold tracking-wider text-neutral-500">
              {axis === 'x' ? 'W' : 'H'}
            </span>
            <input
              type="range"
              min="0.05"
              max="1"
              step="0.01"
              value={size[axis]}
              onChange={(e) => onSizeChange(index, axis, Number(e.target.value))}
              onDoubleClick={() => onSizeChange(index, axis, 1)}
              title={`Output ${axis === 'x' ? 'width' : 'height'} on the final canvas (double-click to reset)`}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-cyan-500"
              aria-label={`Deck ${index + 1} output ${axis === 'x' ? 'width' : 'height'}`}
            />
            <span className="w-7 text-right font-mono text-[9px] text-neutral-400">
              {Math.round(size[axis] * 100)}%
            </span>
          </div>
        ))}
      </div>

      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(index, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate();
        }}
        rows={2}
        placeholder="e.g. neon plasma tunnel pulsing with the bass"
        className="resize-none rounded border border-neutral-700 bg-neutral-950 p-2 text-xs text-neutral-200 placeholder-neutral-600 focus:border-cyan-500 focus:outline-none"
      />

      <button
        type="button"
        onClick={generate}
        disabled={busy || !prompt.trim()}
        className="rounded bg-cyan-600 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        {busy ? badge.label : 'Generate'}
      </button>

      {error && (
        <p className="line-clamp-2 text-[10px] leading-tight text-red-400" title={error}>
          {error}
        </p>
      )}
    </div>
  );
}
