import { useEffect, useState, type RefObject } from 'react';
import type {
  AudioBand,
  AutEffectKey,
  AutomationMap,
  ChannelFilter,
  ChannelFx,
  DeckEntry,
  FilterKind,
} from '../types';
import { SCENE_LETTERS, slotIndex } from '../lib/channels';
import type { PerformanceState } from '../hooks/usePerformanceState';
import { useFullscreen } from '../hooks/useFullscreen';
import { Knob } from './Knob';

// The performance UI is laid out at this fixed design size (matching the target
// 5" 1280×720 touchscreen) and uniformly scaled to fill whatever display it
// runs on — so proportions and touch targets stay consistent everywhere.
const BASE_W = 1280;
const BASE_H = 720;

// Uniform scale factor that fits the BASE_W×BASE_H design into the viewport
// (letterboxed on a non-16:9 screen). Recomputed on resize / fullscreen toggle.
function usePerfScale(): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const compute = () => {
      const s = Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H);
      setScale(s > 0 ? s : 1);
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);
  return scale;
}

function FullscreenIcon({ exit }: { exit: boolean }) {
  const d = exit ? 'M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6' : 'M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6';
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

// Curated quick-FX set for the cramped touchscreen — a useful subset of the
// full studio filter list (DeckModule), not all 13. `id`s match the engine.
const QUICK_FILTERS: { id: FilterKind; label: string }[] = [
  { id: 'none', label: 'Off' },
  { id: 'rgbSplit', label: 'RGB' },
  { id: 'kaleido', label: 'Kaleido' },
  { id: 'pixelate', label: 'Pixel' },
  { id: 'blur', label: 'Blur' },
  { id: 'edge', label: 'Edge' },
  { id: 'invert', label: 'Invert' },
  { id: 'swirl', label: 'Swirl' },
];

// Audio bands (mirrors DeckModule labels) for per-layer reactivity routing.
const BANDS: { id: AudioBand; label: string }[] = [
  { id: 'level', label: 'LVL' },
  { id: 'low', label: 'LO' },
  { id: 'mid', label: 'MID' },
  { id: 'high', label: 'HI' },
  { id: 'beat', label: 'BEAT' },
  { id: 'beat-low', label: 'KICK' },
  { id: 'beat-mid', label: 'SNR' },
  { id: 'beat-high', label: 'HAT' },
];

const PANEL = 'rounded-xl border border-white/10 bg-black/45 p-3 backdrop-blur-md';
const LABEL = 'text-[10px] font-bold uppercase tracking-widest text-neutral-400';

interface PerformanceViewProps {
  perf: PerformanceState;
  decks: DeckEntry[];
  onCueDeck: (deckId: string, scene: number) => void;
  onExit: () => void;
  // The engine draws scene A → aRef and scene B → bRef; we stack B over A by
  // the crossfader to show the live program behind the controls.
  aRef: RefObject<HTMLCanvasElement | null>;
  bRef: RefObject<HTMLCanvasElement | null>;
}

// Simplified, touch-first performance layout. It is the main window in another
// outfit (not a separate window), so it reads and drives the live
// `usePerformanceState` directly — same source of truth as the studio view.
export function PerformanceView({ perf, decks, onCueDeck, onExit, aRef, bRef }: PerformanceViewProps) {
  // Which scene the controls + deck-cueing target. Defaults to B as the
  // "standby" side you prep before transitioning in.
  const [activeScene, setActiveScene] = useState(1);
  const scale = usePerfScale();
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen();
  const xf = perf.crossfade;
  const liveScene = xf < 0.5 ? 0 : 1;

  // TAKE snaps the program fully to a scene AND moves the controls onto it, so
  // you're immediately tweaking whatever just went live.
  const takeScene = (scene: number) => {
    perf.applyCrossfade(scene === 1 ? 1 : 0);
    setActiveScene(scene);
  };

  // full class names (no interpolation) so Tailwind's static scan keeps them
  const cueHoverBorder = activeScene === 1 ? 'hover:border-fuchsia-400' : 'hover:border-cyan-400';

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden bg-black">
      <div
        style={{
          width: BASE_W,
          height: BASE_H,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
        className="relative shrink-0 select-none overflow-hidden bg-black text-neutral-100"
      >
      {/* Live program monitor: scene A under scene B, B faded by the crossfader.
          Anchored top at a fixed 16:9 so the deck aspect the engine derives from
          this canvas stays the output shape. */}
      <div className="absolute inset-x-0 top-0 aspect-video w-full bg-black">
        <canvas ref={aRef} className="absolute inset-0 h-full w-full" />
        <canvas ref={bRef} className="absolute inset-0 h-full w-full" style={{ opacity: xf }} />
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/70" />
      </div>

      <div className="absolute inset-0 flex flex-col">
        {/* Header */}
        <header className="flex items-center gap-2 bg-black/30 px-3 py-2 backdrop-blur-md">
          <span className="text-xs font-black tracking-[0.3em] text-cyan-400">
            PER<span className="text-neutral-200">FORM</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            {[0, 1].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setActiveScene(s)}
                className={`h-7 w-7 rounded text-xs font-black transition-colors ${
                  activeScene === s
                    ? s === 1
                      ? 'bg-fuchsia-500 text-black'
                      : 'bg-cyan-500 text-black'
                    : 'bg-white/10 text-neutral-300 hover:bg-white/20'
                }`}
                title={`Control scene ${SCENE_LETTERS[s]}`}
              >
                {SCENE_LETTERS[s]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              className="ml-1 flex h-7 items-center justify-center rounded bg-white/10 px-2.5 text-neutral-200 transition-colors hover:bg-cyan-600 hover:text-white"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              <FullscreenIcon exit={isFullscreen} />
            </button>
            <button
              type="button"
              onClick={onExit}
              className="ml-1 rounded bg-white/10 px-2.5 py-1.5 text-[10px] font-black tracking-wider text-neutral-200 transition-colors hover:bg-cyan-600 hover:text-white"
              title="Back to the studio layout"
            >
              STUDIO
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {/* Transition */}
          <section className={PANEL}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-black text-cyan-300">A</span>
              <span className={LABEL}>Crossfade</span>
              <span className="text-sm font-black text-fuchsia-300">B</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={xf}
              onChange={(e) => perf.applyCrossfade(Number(e.target.value))}
              style={{ touchAction: 'none' }}
              className="h-3 w-full cursor-pointer accent-neutral-200"
              aria-label="Crossfade A to B"
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => takeScene(0)}
                className={`rounded-lg bg-cyan-600 py-3 text-sm font-black tracking-widest text-white transition-colors hover:bg-cyan-500 ${
                  liveScene === 0 ? 'ring-2 ring-white/70' : ''
                }`}
              >
                TAKE A
              </button>
              <button
                type="button"
                onClick={() => takeScene(1)}
                className={`rounded-lg bg-fuchsia-600 py-3 text-sm font-black tracking-widest text-white transition-colors hover:bg-fuchsia-500 ${
                  liveScene === 1 ? 'ring-2 ring-white/70' : ''
                }`}
              >
                TAKE B
              </button>
            </div>
          </section>

          {/* Deck picker */}
          <section className={PANEL}>
            <div className={`mb-2 ${LABEL}`}>Decks · cue to scene {SCENE_LETTERS[activeScene]}</div>
            {decks.length === 0 ? (
              <div className="py-3 text-center text-xs text-neutral-500">
                No saved decks yet — save decks from the studio view.
              </div>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {decks.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onCueDeck(d.id, activeScene)}
                    className={`group flex w-24 shrink-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-white/5 text-left transition-colors ${cueHoverBorder}`}
                  >
                    <div className="aspect-video w-full bg-black/60">
                      {d.screenshot && (
                        <img
                          src={d.screenshot}
                          alt=""
                          className="h-full w-full object-cover opacity-90 group-hover:opacity-100"
                        />
                      )}
                    </div>
                    <span className="truncate px-1.5 py-1 text-[10px] font-semibold text-neutral-300">
                      {d.name ?? 'Untitled deck'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Per-channel controls for the active scene */}
          <section className={PANEL}>
            <div className={`mb-2 ${LABEL}`}>Scene {SCENE_LETTERS[activeScene]} layers</div>
            <div className="space-y-2">
              {[0, 1, 2, 3].map((ch) => {
                const slot = slotIndex(activeScene, ch);
                const fx = perf.fx[slot];
                const filter = perf.filters[slot];
                return (
                  <ChannelCard
                    key={ch}
                    channel={ch}
                    label={perf.prompts[slot]?.trim() || `Layer ${ch + 1}`}
                    opacity={perf.opacities[slot]}
                    muted={perf.muted[slot]}
                    filter={filter}
                    fx={fx}
                    aut={perf.aut[slot]}
                    onOpacity={(v) => perf.applyOpacity(slot, v)}
                    onToggleMute={() => perf.toggleMute(slot)}
                    onFilter={(k, v) => perf.applyFilter(slot, k, v)}
                    onFx={(k, v) => perf.applyFx(slot, k, v)}
                    onAut={(eff, v) => perf.applyAut(slot, eff, 'amt', v)}
                  />
                );
              })}
            </div>
          </section>
        </div>
      </div>
      </div>
    </div>
  );
}

interface ChannelCardProps {
  channel: number;
  label: string;
  opacity: number;
  muted: boolean;
  filter: ChannelFilter;
  fx: ChannelFx;
  aut: AutomationMap;
  onOpacity: (v: number) => void;
  onToggleMute: () => void;
  onFilter: (key: keyof ChannelFilter, value: ChannelFilter[keyof ChannelFilter]) => void;
  onFx: (key: keyof ChannelFx, value: ChannelFx[keyof ChannelFx]) => void;
  onAut: (effect: AutEffectKey, value: number) => void;
}

const COLOUR_ACCENT = '#a78bfa';
const AUT_ACCENT = '#fbbf24';

function ChannelCard(p: ChannelCardProps) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-black text-neutral-500">{p.channel + 1}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-200">
          {p.label}
        </span>
        <button
          type="button"
          onClick={p.onToggleMute}
          className={`rounded px-2 py-1 text-[10px] font-black tracking-wider transition-colors ${
            p.muted ? 'bg-red-600 text-white' : 'bg-white/10 text-neutral-300 hover:bg-white/20'
          }`}
        >
          {p.muted ? 'MUTED' : 'MUTE'}
        </button>
      </div>

      {/* Sliders on the left, dials at their end — keeps each card short. */}
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
          {/* Level */}
          <div className="flex items-center gap-2">
            <span className="w-9 text-[9px] font-bold uppercase tracking-wider text-neutral-500">Lvl</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={p.opacity}
              onChange={(e) => p.onOpacity(Number(e.target.value))}
              style={{ touchAction: 'none' }}
              className="h-2.5 flex-1 cursor-pointer accent-emerald-400"
              aria-label={`Layer ${p.channel + 1} level`}
            />
            <span className="w-9 text-right text-[10px] tabular-nums text-neutral-400">
              {Math.round(p.opacity * 100)}
            </span>
          </div>

          {/* Quick FX */}
          <div className="flex items-center gap-2">
            <select
              value={p.filter.kind}
              onChange={(e) => p.onFilter('kind', e.target.value as FilterKind)}
              className="rounded border border-white/10 bg-black/50 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-cyan-500 focus:outline-none"
              aria-label={`Layer ${p.channel + 1} filter`}
            >
              {QUICK_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={p.filter.amount}
              onChange={(e) => p.onFilter('amount', Number(e.target.value))}
              disabled={p.filter.kind === 'none'}
              style={{ touchAction: 'none' }}
              className="h-2.5 flex-1 cursor-pointer accent-violet-400 disabled:opacity-30"
              aria-label={`Layer ${p.channel + 1} filter amount`}
            />
          </div>

          {/* Audio reactivity */}
          <div className="flex items-center gap-2">
            <select
              value={p.fx.band}
              onChange={(e) => p.onFx('band', e.target.value as AudioBand)}
              className="rounded border border-white/10 bg-black/50 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-cyan-500 focus:outline-none"
              aria-label={`Layer ${p.channel + 1} audio band`}
            >
              {BANDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={p.fx.amt}
              onChange={(e) => p.onFx('amt', Number(e.target.value))}
              style={{ touchAction: 'none' }}
              className="h-2.5 flex-1 cursor-pointer accent-amber-400"
              aria-label={`Layer ${p.channel + 1} audio amount`}
            />
            <span className="w-9 text-right text-[10px] tabular-nums text-neutral-400">
              {p.fx.amt.toFixed(1)}×
            </span>
          </div>
        </div>

        {/* Colour + AUT dials, stacked at the end of the sliders */}
        <div className="flex shrink-0 flex-col justify-center gap-1">
          <div className="flex gap-0.5">
            <Knob label="CON" value={p.fx.contrast} min={0} max={2} defaultValue={1} accent={COLOUR_ACCENT} onChange={(v) => p.onFx('contrast', v)} />
            <Knob label="HUE" value={p.fx.hue} min={-180} max={180} defaultValue={0} bipolar accent={COLOUR_ACCENT} format={(v) => `${Math.round(v)}°`} onChange={(v) => p.onFx('hue', v)} />
            <Knob label="SAT" value={p.fx.sat} min={0} max={2} defaultValue={1} accent={COLOUR_ACCENT} onChange={(v) => p.onFx('sat', v)} />
          </div>
          <div className="flex gap-0.5">
            <Knob label="SCL" value={p.aut.scl.amt} min={0} max={1} defaultValue={0} accent={AUT_ACCENT} onChange={(v) => p.onAut('scl', v)} />
            <Knob label="ROT" value={p.aut.rot.amt} min={0} max={1} defaultValue={0} accent={AUT_ACCENT} onChange={(v) => p.onAut('rot', v)} />
            <Knob label="FLK" value={p.aut.flk.amt} min={0} max={1} defaultValue={0} accent={AUT_ACCENT} onChange={(v) => p.onAut('flk', v)} />
          </div>
        </div>
      </div>
    </div>
  );
}
