import { useState } from 'react';
import { Knob } from './Knob';
import { LooperModal } from './LooperModal';
import type {
  AudioBand,
  AutEffectKey,
  AutomationMap,
  ChannelFilter,
  ChannelFx,
  ChannelLight,
  ChannelPos,
  ChannelSize,
  DeckLoop,
  DeckStatus,
  FilterKind,
  LoopControlId,
  SourceType,
  VideoPlayback,
} from '../types';

const STATUS_STYLES: Record<DeckStatus, { label: string; className: string }> = {
  idle: { label: 'Idle', className: 'bg-neutral-700 text-neutral-300' },
  queued: { label: 'Queued', className: 'bg-amber-500/20 text-amber-300' },
  generating: { label: 'Generating', className: 'bg-blue-500/20 text-blue-300 animate-pulse' },
  compiling: { label: 'Compiling', className: 'bg-purple-500/20 text-purple-300 animate-pulse' },
  active: { label: 'Active', className: 'bg-emerald-500/20 text-emerald-300' },
  failed: { label: 'Compile Failed', className: 'bg-red-500/20 text-red-300' },
  error: { label: 'Error', className: 'bg-red-500/20 text-red-300' },
};

const BUSY_STATUSES: DeckStatus[] = ['queued', 'generating', 'compiling'];

const TABS = ['XFRM', 'AUDIO', 'COLOR', 'FILTER', 'AUT', 'LOOP'];

// Per-deck output filters. `id`s match FILTER_KINDS in the Rust engine
// (params.rs) and the `switch` in filter.wgsl; `amt`/`p2` label the two generic
// 0..1 knobs (p2 omitted = single-control filter). ★ ones react to audio/time.
const FILTERS: { id: FilterKind; label: string; amt: string; p2?: string }[] = [
  { id: 'none', label: 'Off', amt: '' },
  { id: 'invert', label: 'Invert', amt: 'AMT' },
  { id: 'hue', label: 'Hue Shift', amt: 'ROT' },
  { id: 'posterize', label: 'Posterize', amt: 'STEP' },
  { id: 'pixelate', label: 'Pixelate', amt: 'SIZE' },
  { id: 'scanlines', label: 'Scanlines', amt: 'AMT', p2: 'DENS' },
  { id: 'edge', label: 'Edge', amt: 'MIX', p2: 'WIDTH' },
  { id: 'rgbSplit', label: 'RGB Split', amt: 'AMT', p2: 'ANGLE' },
  { id: 'kaleido', label: 'Kaleido', amt: 'SEG', p2: 'ROT' },
  { id: 'swirl', label: 'Swirl', amt: 'AMT', p2: 'RAD' },
  { id: 'blur', label: 'Blur', amt: 'AMT' },
  { id: 'lumaKey', label: 'Luma Key', amt: 'THR', p2: 'SOFT' },
  { id: 'ripple', label: 'Ripple', amt: 'AMT', p2: 'FREQ' },
];

// deck types with a real light rig (only sprites are unlit)
const LIT_SOURCES: SourceType[] = ['model', 'landscape', 'scene'];

// decks whose content can be mirror-tiled to fill the frame when scaled down
const TILEABLE_SOURCES: SourceType[] = ['sprite', 'video', 'model'];

const AUT_EFFECTS: { key: AutEffectKey; label: string; title: string }[] = [
  { key: 'scl', label: 'SCL', title: 'Scaling' },
  { key: 'rot', label: 'ROT', title: 'Rotation' },
  { key: 'tlt', label: 'TLT', title: 'Tilt rocking (composite — works on every deck type)' },
  { key: 'flk', label: 'FLK', title: 'Flicker' },
  { key: 'dst', label: 'DST', title: 'Distortion' },
  { key: 'skw', label: 'SKW', title: 'Skew' },
];

const BANDS: { id: AudioBand; label: string; title: string }[] = [
  { id: 'low', label: 'LO', title: 'Low band (bass)' },
  { id: 'mid', label: 'MID', title: 'Mid band' },
  { id: 'high', label: 'HI', title: 'High band (treble)' },
  { id: 'level', label: 'LVL', title: 'Full-spectrum level' },
  { id: 'beat', label: 'BEAT', title: 'Combined beat (enabled layers)' },
  { id: 'beat-low', label: 'KICK', title: 'Kick layer (low-band beat)' },
  { id: 'beat-mid', label: 'SNR', title: 'Snare layer (mid-band beat)' },
  { id: 'beat-high', label: 'HAT', title: 'Hat layer (high-band beat)' },
];

interface DeckModuleProps {
  index: number;
  sceneLetter: string;
  status: DeckStatus;
  error: string | null;
  prompt: string;
  onPromptChange: (channel: number, text: string) => void;
  scale: number;
  onScaleChange: (channel: number, value: number) => void;
  size: ChannelSize;
  onSizeChange: (channel: number, axis: 'x' | 'y', value: number) => void;
  /** in-scene offset — landscape camera pan/height, model/sprite shift */
  pos: ChannelPos;
  onPosChange: (channel: number, axis: 'x' | 'y', value: number) => void;
  light: ChannelLight;
  onLightChange: (channel: number, key: keyof ChannelLight, value: number) => void;
  /** compositing layer 1 (top) .. 4 (base) */
  layer: number;
  onLayerChange: (channel: number, layer: number) => void;
  /** mirror-tile the content to fill when scaled (sprite/video/model only) */
  tile: boolean;
  onTileChange: (channel: number, value: boolean) => void;
  loop: DeckLoop;
  onLoopChange: (channel: number, loop: DeckLoop) => void;
  sourceType: SourceType;
  fx: ChannelFx;
  onFxChange: <K extends keyof ChannelFx>(channel: number, key: K, value: ChannelFx[K]) => void;
  filter: ChannelFilter;
  onFilterChange: <K extends keyof ChannelFilter>(
    channel: number,
    key: K,
    value: ChannelFilter[K],
  ) => void;
  aut: AutomationMap;
  onAutChange: (
    channel: number,
    effect: AutEffectKey,
    field: 'amt' | 'audio',
    value: number | boolean,
  ) => void;
  videoPlayback: VideoPlayback;
  onVideoChange: <K extends keyof VideoPlayback>(
    channel: number,
    key: K,
    value: VideoPlayback[K],
  ) => void;
  onGenerate: (channel: number, prompt: string, mode: 'shader' | 'scene') => void;
  onRegenerate: (channel: number, prompt: string, mode: 'shader' | 'scene') => void;
  onSave: (channel: number) => void | Promise<void>;
  onReset: (channel: number) => void;
  previewRef: (el: HTMLCanvasElement | null) => void;
}

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
  pos,
  onPosChange,
  light,
  onLightChange,
  layer,
  onLayerChange,
  tile,
  onTileChange,
  loop,
  onLoopChange,
  sourceType,
  fx,
  onFxChange,
  filter,
  onFilterChange,
  aut,
  onAutChange,
  videoPlayback,
  onVideoChange,
  onGenerate,
  onRegenerate,
  onSave,
  onReset,
  previewRef,
}: DeckModuleProps) {
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState('XFRM');
  const [aspectLocked, setAspectLocked] = useState(false);
  // what Generate produces: a GLSL shader, or a procedural fly-through scene
  const [genMode, setGenMode] = useState<'shader' | 'scene'>('shader');
  const [looperOpen, setLooperOpen] = useState(false);

  const clampSize = (v: number) => Math.min(1, Math.max(0.05, v));
  // when locked, moving one axis scales the other by the same factor
  const handleSize = (axis: 'x' | 'y', value: number) => {
    onSizeChange(index, axis, value);
    if (aspectLocked) {
      const other = axis === 'x' ? 'y' : 'x';
      const factor = value / (size[axis] || 0.05);
      onSizeChange(index, other, clampSize(size[other] * factor));
    }
  };
  const resetSize = (axis: 'x' | 'y') => {
    onSizeChange(index, axis, 1);
    if (aspectLocked) onSizeChange(index, axis === 'x' ? 'y' : 'x', 1);
  };
  const badge = STATUS_STYLES[status] || STATUS_STYLES.idle;
  const busy = BUSY_STATUSES.includes(status);

  // LIGHT only exists for lit deck types; VIDEO only for video decks.
  const tabs =
    sourceType === 'video'
      ? [...TABS, 'VIDEO']
      : LIT_SOURCES.includes(sourceType)
        ? [...TABS, 'LIGHT']
        : TABS;
  const effectiveTab = tabs.includes(tab) ? tab : 'XFRM';

  const activeFilter = FILTERS.find((f) => f.id === filter.kind) ?? FILTERS[0];


  // current channel values normalized into lane space, to seed new lanes
  const norm = (v: number, lo: number, hi: number) => (v - lo) / (hi - lo);
  const laneSeeds: Partial<Record<LoopControlId, number>> = {
    opacity: 1, // multiplicative neutral
    scale: norm(scale, 0.25, 3),
    sizeX: norm(size.x, 0.05, 1),
    sizeY: norm(size.y, 0.05, 1),
    posX: norm(pos.x, -2, 2),
    posY: norm(pos.y, -2, 2),
    tilt: norm(fx.tilt, -180, 180),
    contrast: norm(fx.contrast, 0, 2),
    hue: norm(fx.hue, -180, 180),
    sat: norm(fx.sat, 0, 2),
    brightness: norm(light.brightness, 0, 2),
    lightAngle: norm(light.angle, -180, 180),
  };

  const laneCount = Object.keys(loop.lanes).length;

  const generate = () => {
    if (prompt.trim() && !busy) onGenerate(index, prompt.trim(), genMode);
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
            onClick={() => onReset(index)}
            title="Reset scale, size, color and automation to defaults (keeps the visual)"
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-neutral-400 transition-colors hover:border-amber-500 hover:text-amber-300"
          >
            RESET
          </button>
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
      <div className="flex gap-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <canvas
            ref={previewRef}
            width={160}
            height={90}
            className="aspect-video w-full rounded border border-neutral-800 bg-black object-contain"
          />
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold tracking-wider text-neutral-500">W</span>
            <input
              type="range"
              min="0.05"
              max="1"
              step="0.01"
              value={size.x}
              onChange={(e) => handleSize('x', Number(e.target.value))}
              onDoubleClick={() => resetSize('x')}
              title="Output width on the final canvas (double-click to reset)"
              className="h-1 min-w-0 flex-1 cursor-pointer accent-cyan-500"
              aria-label={`Deck ${index + 1} output width`}
            />
            <span className="w-7 text-right font-mono text-[9px] text-neutral-400">
              {Math.round(size.x * 100)}%
            </span>
          </div>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] font-bold tracking-wider text-neutral-500">H</span>
          <input
            type="range"
            min="0.05"
            max="1"
            step="0.01"
            value={size.y}
            onChange={(e) => handleSize('y', Number(e.target.value))}
            onDoubleClick={() => resetSize('y')}
            title="Output height on the final canvas (double-click to reset)"
            className="vert-slider min-h-0 flex-1"
            aria-label={`Deck ${index + 1} output height`}
          />
          <span className="w-7 text-center font-mono text-[9px] text-neutral-400">
            {Math.round(size.y * 100)}
          </span>
          <button
            type="button"
            onClick={() => setAspectLocked((prev) => !prev)}
            aria-pressed={aspectLocked}
            title={
              aspectLocked
                ? 'Aspect ratio locked — W and H move together (click to unlock)'
                : 'Lock aspect ratio — W and H move together'
            }
            className={`flex h-4 w-7 items-center justify-center rounded transition-colors ${
              aspectLocked
                ? 'bg-cyan-600/30 text-cyan-300'
                : 'text-neutral-600 hover:text-neutral-300'
            }`}
          >
            {aspectLocked ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a5 5 0 0 0-5 5h2a3 3 0 1 1 6 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-2 py-0.5 text-[9px] font-bold tracking-wider transition-colors ${
              effectiveTab === t
                ? 'bg-neutral-700 text-cyan-300'
                : 'bg-neutral-950 text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {t}
          </button>
        ))}
        <div
          className="ml-auto flex items-center gap-0.5"
          title="Compositing layer: 1 renders on top, 4 is the base. Decks on the same layer blend additively; content on a higher layer covers what's beneath it (image/3D transparency cuts through)."
        >
          <span className="text-[8px] font-bold tracking-wider text-neutral-600">LYR</span>
          {[1, 2, 3, 4].map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => onLayerChange(index, l)}
              aria-pressed={layer === l}
              aria-label={`Layer ${l}`}
              className={`w-4 rounded-sm text-[9px] font-bold leading-4 transition-colors ${
                layer === l
                  ? 'bg-amber-600 text-white'
                  : 'bg-neutral-950 text-neutral-600 hover:text-neutral-300'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="flex h-20 items-center justify-evenly gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {effectiveTab === 'XFRM' && (
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
            {TILEABLE_SOURCES.includes(sourceType) && (
              <div className="flex w-12 shrink-0 flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={() => onTileChange(index, !tile)}
                  aria-pressed={tile}
                  title={
                    tile
                      ? 'Tiling on — content repeats to fill the frame as you scale down. Click for a single copy.'
                      : 'Tiling off — a single scaled copy with empty margins. Click to tile and fill the frame.'
                  }
                  className={`flex h-9 w-9 items-center justify-center rounded-full border text-[8px] font-black transition-colors ${
                    tile
                      ? 'border-cyan-500 bg-cyan-600/30 text-cyan-200'
                      : 'border-neutral-700 bg-neutral-900 text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  {tile ? 'ON' : 'OFF'}
                </button>
                <span className="text-[8px] font-bold tracking-wider text-neutral-500">TILE</span>
              </div>
            )}
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
            {sourceType !== 'shader' && (
              <>
                <Knob
                  label="POS X"
                  value={pos.x}
                  min={-2}
                  max={2}
                  defaultValue={0}
                  bipolar
                  format={(v) => v.toFixed(1)}
                  onChange={(v) => onPosChange(index, 'x', v)}
                />
                <Knob
                  label="POS Y"
                  value={pos.y}
                  min={-2}
                  max={2}
                  defaultValue={0}
                  bipolar
                  format={(v) => v.toFixed(1)}
                  onChange={(v) => onPosChange(index, 'y', v)}
                />
              </>
            )}
          </>
        )}

        {effectiveTab === 'AUDIO' && (
          <>
            <div className="flex flex-col items-center gap-1">
              <div className="grid grid-cols-4 overflow-hidden rounded border border-neutral-700">
                {BANDS.map((band) => (
                  <button
                    key={band.id}
                    type="button"
                    onClick={() => onFxChange(index, 'band', band.id)}
                    title={`Drive this channel's u_audio_level from: ${band.title}`}
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

        {effectiveTab === 'VIDEO' && (
          <>
            <Knob
              label="RATE"
              value={videoPlayback.rate}
              min={0}
              max={4}
              defaultValue={1}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={(v) => onVideoChange(index, 'rate', v)}
            />
            <div className="flex flex-col items-center gap-1">
              <div className="grid grid-cols-3 overflow-hidden rounded border border-neutral-700">
                {(['loop', 'once', 'ping'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onVideoChange(index, 'loopMode', m)}
                    title={
                      m === 'loop'
                        ? 'Loop continuously'
                        : m === 'once'
                          ? 'Play once and hold the last frame'
                          : 'Ping-pong (forward then reverse)'
                    }
                    className={`px-1.5 py-1 text-[8px] font-bold transition-colors ${
                      videoPlayback.loopMode === m
                        ? 'bg-cyan-600 text-white'
                        : 'bg-neutral-950 text-neutral-500 hover:text-neutral-300'
                    }`}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onVideoChange(index, 'reverse', !videoPlayback.reverse)}
                title="Play backward (ignored in ping-pong / beat-flip)"
                className={`w-full rounded px-1.5 py-0.5 text-[8px] font-bold transition-colors ${
                  videoPlayback.reverse
                    ? 'bg-cyan-600 text-white'
                    : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                REV
              </button>
              <span className="text-[8px] font-bold tracking-wider text-neutral-500">PLAY</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="grid grid-cols-2 gap-0.5">
                {(
                  [
                    ['beatSync', 'SYNC', 'Lock the loop to the BPM'],
                    ['beatJump', 'JUMP', 'Restart on each beat'],
                    ['beatRate', 'RATE', 'Pulse speed with the beat'],
                    ['beatFlip', 'FLIP', 'Flip direction on each beat'],
                  ] as const
                ).map(([key, label, title]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onVideoChange(index, key, !videoPlayback[key])}
                    title={title}
                    className={`rounded px-1.5 py-0.5 text-[8px] font-bold transition-colors ${
                      videoPlayback[key]
                        ? 'bg-fuchsia-600 text-white'
                        : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-[8px] font-bold tracking-wider text-neutral-500">BEAT</span>
            </div>
            {videoPlayback.beatSync && (
              <div className="flex flex-col items-center gap-1">
                <div className="grid grid-cols-2 overflow-hidden rounded border border-neutral-700">
                  {[1, 2, 4, 8].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => onVideoChange(index, 'beatDiv', n)}
                      className={`px-1.5 py-1 text-[8px] font-bold transition-colors ${
                        videoPlayback.beatDiv === n
                          ? 'bg-cyan-600 text-white'
                          : 'bg-neutral-950 text-neutral-500 hover:text-neutral-300'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span className="text-[8px] font-bold tracking-wider text-neutral-500">BEATS</span>
              </div>
            )}
          </>
        )}

        {effectiveTab === 'COLOR' && (
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

        {effectiveTab === 'FILTER' && (
          <>
            <div className="flex flex-col items-center gap-1">
              <select
                value={filter.kind}
                onChange={(e) => onFilterChange(index, 'kind', e.target.value as FilterKind)}
                title="Post filter applied to this deck's visible output"
                aria-label={`Deck ${index + 1} filter`}
                className="max-w-[5.5rem] rounded border border-neutral-700 bg-neutral-950 px-1 py-1 text-[10px] text-neutral-300 focus:border-cyan-500 focus:outline-none"
              >
                {FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <span className="text-[8px] font-bold tracking-wider text-neutral-500">FILTER</span>
            </div>
            {filter.kind !== 'none' && (
              <>
                <Knob
                  label={activeFilter.amt}
                  value={filter.amount}
                  min={0}
                  max={1}
                  defaultValue={0.5}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => onFilterChange(index, 'amount', v)}
                />
                {activeFilter.p2 && (
                  <Knob
                    label={activeFilter.p2}
                    value={filter.param2}
                    min={0}
                    max={1}
                    defaultValue={0.5}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => onFilterChange(index, 'param2', v)}
                  />
                )}
              </>
            )}
          </>
        )}

        {effectiveTab === 'AUT' &&
          AUT_EFFECTS.map(({ key, label, title }) => (
            <div key={key} className="flex flex-col items-center gap-1">
              <Knob
                label={label}
                value={aut[key].amt}
                min={0}
                max={1}
                defaultValue={0}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => onAutChange(index, key, 'amt', v)}
              />
              <button
                type="button"
                onClick={() => onAutChange(index, key, 'audio', !aut[key].audio)}
                aria-pressed={aut[key].audio}
                title={`${title}: ${
                  aut[key].audio
                    ? 'audio-coupled (driven by this channel’s BAND/AMT routing)'
                    : 'self-running — click to couple to audio'
                }`}
                className={`rounded px-1.5 text-[10px] leading-4 transition-colors ${
                  aut[key].audio
                    ? 'bg-cyan-600 text-white shadow-[0_0_6px_rgba(34,211,238,0.5)]'
                    : 'bg-neutral-950 text-neutral-600 hover:text-neutral-300'
                }`}
              >
                ♪
              </button>
            </div>
          ))}
        {effectiveTab === 'LOOP' && (
          <>
            <button
              type="button"
              onClick={() => onLoopChange(index, { ...loop, playing: !loop.playing })}
              aria-pressed={loop.playing}
              title={
                loop.playing
                  ? 'Pause the automation loop (controls return to the knobs)'
                  : 'Play the automation loop, beat-locked to the global BPM'
              }
              className={`rounded px-4 py-2 text-sm font-bold transition-colors ${
                loop.playing
                  ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                  : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {loop.playing ? '⏸' : '▶'}
            </button>
            <button
              type="button"
              onClick={() => setLooperOpen(true)}
              className="rounded border border-neutral-700 px-4 py-2 text-xs font-bold tracking-wider text-neutral-300 transition-colors hover:border-cyan-500 hover:text-cyan-300"
            >
              EDIT
            </button>
            <span className="text-[9px] leading-tight text-neutral-500">
              {laneCount} lane{laneCount === 1 ? '' : 's'}
              <br />
              {loop.blocks} × {loop.divider < 1 ? `1/${1 / loop.divider}` : loop.divider}♪
            </span>
          </>
        )}

        {effectiveTab === 'LIGHT' && (
          <>
            <Knob
              label="BRT"
              value={light.brightness}
              min={0}
              max={2}
              defaultValue={1}
              format={(v) => `${v.toFixed(2)}x`}
              onChange={(v) => onLightChange(index, 'brightness', v)}
            />
            <Knob
              label="DIR"
              value={light.angle}
              min={-180}
              max={180}
              defaultValue={0}
              bipolar
              format={(v) => `${Math.round(v)}°`}
              onChange={(v) => onLightChange(index, 'angle', v)}
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

      {status === 'failed' || status === 'error' ? (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => prompt.trim() && onRegenerate(index, prompt.trim(), genMode)}
            disabled={!prompt.trim()}
            title="Send the prompt plus the failing code and compiler error back to the model to fix"
            className="flex-1 rounded bg-amber-600 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            ⟲ Regenerate
          </button>
          <button
            type="button"
            onClick={generate}
            disabled={!prompt.trim()}
            title="Generate from the prompt alone, ignoring the failed attempt"
            className="flex-1 rounded bg-cyan-600 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            Start fresh
          </button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <div
            className="flex overflow-hidden rounded border border-neutral-700"
            title="GLSL: the model writes a fragment shader. SCENE: the model designs a 3D fly-through (terrain or tunnel)"
          >
            {(['shader', 'scene'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setGenMode(mode)}
                aria-pressed={genMode === mode}
                className={`px-1.5 text-[8px] font-bold tracking-wider transition-colors ${
                  genMode === mode
                    ? 'bg-cyan-600 text-white'
                    : 'bg-neutral-950 text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {mode === 'shader' ? 'GLSL' : 'SCENE'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={generate}
            disabled={busy || !prompt.trim()}
            className="flex-1 rounded bg-cyan-600 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {busy ? badge.label : 'Generate'}
          </button>
        </div>
      )}

      {error && (
        <p className="line-clamp-2 text-[10px] leading-tight text-red-400" title={error}>
          {error}
        </p>
      )}

      {looperOpen && (
        <LooperModal
          deckLabel={`${sceneLetter}${index + 1}`}
          loop={loop}
          currentValues={laneSeeds}
          onChange={(next) => onLoopChange(index, next)}
          onClose={() => setLooperOpen(false)}
        />
      )}
    </div>
  );
}
