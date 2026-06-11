import { useState } from 'react';
import { Knob } from './Knob';

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

const TABS = ['XFRM', 'AUDIO', 'COLOR'];

const BANDS = [
  { id: 'low', label: 'LO' },
  { id: 'mid', label: 'MID' },
  { id: 'high', label: 'HI' },
  { id: 'level', label: 'LVL' },
];

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
  fx,
  onFxChange,
  onGenerate,
  onSave,
  previewRef,
}) {
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState('XFRM');
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
      <div className="flex items-stretch gap-1.5">
        <canvas
          ref={previewRef}
          width={160}
          height={90}
          className="aspect-video min-w-0 flex-1 rounded border border-neutral-800 bg-black object-contain"
        />
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] font-bold tracking-wider text-neutral-500">H</span>
          <input
            type="range"
            min="0.05"
            max="1"
            step="0.01"
            value={size.y}
            onChange={(e) => onSizeChange(index, 'y', Number(e.target.value))}
            onDoubleClick={() => onSizeChange(index, 'y', 1)}
            title="Output height on the final canvas (double-click to reset)"
            className="vert-slider min-h-0 flex-1"
            aria-label={`Deck ${index + 1} output height`}
          />
          <span className="w-7 text-center font-mono text-[9px] text-neutral-400">
            {Math.round(size.y * 100)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-bold tracking-wider text-neutral-500">W</span>
        <input
          type="range"
          min="0.05"
          max="1"
          step="0.01"
          value={size.x}
          onChange={(e) => onSizeChange(index, 'x', Number(e.target.value))}
          onDoubleClick={() => onSizeChange(index, 'x', 1)}
          title="Output width on the final canvas (double-click to reset)"
          className="h-1 min-w-0 flex-1 cursor-pointer accent-cyan-500"
          aria-label={`Deck ${index + 1} output width`}
        />
        <span className="w-7 text-right font-mono text-[9px] text-neutral-400">
          {Math.round(size.x * 100)}%
        </span>
      </div>

      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-2 py-0.5 text-[9px] font-bold tracking-wider transition-colors ${
              tab === t
                ? 'bg-neutral-700 text-cyan-300'
                : 'bg-neutral-950 text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex h-16 items-center justify-evenly">
        {tab === 'XFRM' && (
          <>
            <Knob
              label="SCALE"
              value={scale}
              min={0.25}
              max={3}
              defaultValue={1}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={(v) => onScaleChange(index, v)}
            />
            <Knob
              label="TILT"
              value={fx.tilt}
              min={-180}
              max={180}
              defaultValue={0}
              bipolar
              format={(v) => `${Math.round(v)}°`}
              onChange={(v) => onFxChange(index, 'tilt', v)}
            />
          </>
        )}

        {tab === 'AUDIO' && (
          <>
            <div className="flex flex-col items-center gap-1">
              <div className="flex overflow-hidden rounded border border-neutral-700">
                {BANDS.map((band) => (
                  <button
                    key={band.id}
                    type="button"
                    onClick={() => onFxChange(index, 'band', band.id)}
                    title={`Drive this channel's u_audio_level from the ${band.label} band`}
                    className={`px-1.5 py-1 text-[8px] font-bold transition-colors ${
                      fx.band === band.id
                        ? 'bg-cyan-600 text-white'
                        : 'bg-neutral-950 text-neutral-500 hover:text-neutral-300'
                    }`}
                  >
                    {band.label}
                  </button>
                ))}
              </div>
              <span className="text-[8px] font-bold tracking-wider text-neutral-500">BAND</span>
            </div>
            <Knob
              label="AMT"
              value={fx.amt}
              min={0}
              max={2}
              defaultValue={1}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={(v) => onFxChange(index, 'amt', v)}
            />
          </>
        )}

        {tab === 'COLOR' && (
          <>
            <Knob
              label="CON"
              value={fx.contrast}
              min={0}
              max={2}
              defaultValue={1}
              format={(v) => v.toFixed(2)}
              onChange={(v) => onFxChange(index, 'contrast', v)}
            />
            <Knob
              label="HUE"
              value={fx.hue}
              min={-180}
              max={180}
              defaultValue={0}
              bipolar
              format={(v) => `${Math.round(v)}°`}
              onChange={(v) => onFxChange(index, 'hue', v)}
            />
            <Knob
              label="SAT"
              value={fx.sat}
              min={0}
              max={2}
              defaultValue={1}
              format={(v) => v.toFixed(2)}
              onChange={(v) => onFxChange(index, 'sat', v)}
            />
          </>
        )}
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
