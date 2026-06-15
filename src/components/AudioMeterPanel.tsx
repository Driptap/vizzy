import { CHANNELS, SCENE_LETTERS, sceneOfSlot } from '../lib/channels';
import { useMeters, type MeterStore } from '../hooks/useAudioMeters';
import type { AudioBand, BeatBandConfig, ChannelFx } from '../types';
import { Knob } from './Knob';

const SPECTRUM: { key: 'low' | 'mid' | 'high' | 'level'; label: string; color: string }[] = [
  { key: 'low', label: 'LOW', color: '#22d3ee' },
  { key: 'mid', label: 'MID', color: '#a3e635' },
  { key: 'high', label: 'HIGH', color: '#f472b6' },
  { key: 'level', label: 'LVL', color: '#e5e5e5' },
];

const BAND_LABEL: Record<AudioBand, string> = {
  low: 'LO',
  mid: 'MID',
  high: 'HI',
  level: 'LVL',
  beat: 'BEAT',
  'beat-low': 'KICK',
  'beat-mid': 'SNR',
  'beat-high': 'HAT',
};

// One config row per detection layer. `meter` indexes the live per-layer
// envelope; `fromHz`/`toHz` carry that layer's sensible knob bounds + defaults.
const LAYERS: {
  label: string;
  color: string;
  meter: 'beatLow' | 'beatMid' | 'beatHigh';
  fromHz: { min: number; max: number; def: number };
  toHz: { min: number; max: number; def: number };
  sensDef: number;
  gapDef: number;
  decayDef: number;
}[] = [
  {
    label: 'KICK',
    color: '#22d3ee',
    meter: 'beatLow',
    fromHz: { min: 20, max: 120, def: 30 },
    toHz: { min: 80, max: 400, def: 150 },
    sensDef: 1.3,
    gapDef: 120,
    decayDef: 0.12,
  },
  {
    label: 'SNARE',
    color: '#a3e635',
    meter: 'beatMid',
    fromHz: { min: 120, max: 600, def: 200 },
    toHz: { min: 600, max: 4000, def: 2000 },
    sensDef: 1.6,
    gapDef: 110,
    decayDef: 0.14,
  },
  {
    label: 'HAT',
    color: '#f472b6',
    meter: 'beatHigh',
    fromHz: { min: 1500, max: 6000, def: 3000 },
    toHz: { min: 4000, max: 14000, def: 8000 },
    sensDef: 1.9,
    gapDef: 80,
    decayDef: 0.1,
  },
];

const fmtHz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

function VBar({ value, color, height = 56 }: { value: number; color: string; height?: number }) {
  return (
    <span
      className="flex w-3 items-end overflow-hidden rounded-sm bg-neutral-800"
      style={{ height }}
      aria-hidden
    >
      <span
        className="w-full rounded-sm"
        style={{ height: `${Math.min(100, value * 100)}%`, background: color }}
      />
    </span>
  );
}

interface Props {
  store: MeterStore;
  fx: ChannelFx[];
  bpmSync: boolean;
  onToggleBpmSync: (on: boolean) => void;
  beatBands: BeatBandConfig[];
  onBeatBandChange: <K extends keyof BeatBandConfig>(
    index: number,
    key: K,
    value: BeatBandConfig[K],
  ) => void;
}

/**
 * The expandable audio panel: per-band spectrum, the combined beat + tempo with
 * a sync toggle, three independent detection layers (KICK/SNARE/HAT) each with
 * its own meter, enable toggle and tuning knobs, and the live post-routing value
 * each deck is receiving.
 */
export function AudioMeterPanel({
  store,
  fx,
  bpmSync,
  onToggleBpmSync,
  beatBands,
  onBeatBandChange,
}: Props) {
  const m = useMeters(store);
  return (
    <div className="flex flex-col gap-3 overflow-x-auto border-b border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex items-stretch gap-6">
        {/* Spectrum */}
        <section className="flex flex-col gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">Bands</span>
          <div className="flex items-end gap-2">
            {SPECTRUM.map((s) => (
              <div key={s.key} className="flex flex-col items-center gap-1">
                <VBar value={m[s.key]} color={s.color} />
                <span className="text-[8px] font-bold tracking-wider text-neutral-500">{s.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Combined beat + BPM */}
        <section className="flex flex-col gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">Beat</span>
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="h-8 w-8 rounded-full bg-red-500"
              style={{ opacity: 0.15 + m.beat * 0.85, transform: `scale(${0.6 + m.beat * 0.5})` }}
            />
            <div className="flex flex-col">
              <span className="font-mono text-2xl leading-none tabular-nums text-neutral-100">
                {m.bpm > 0 ? Math.round(m.bpm) : '--'}
                <span className="ml-1 text-[10px] text-neutral-500">BPM</span>
              </span>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onToggleBpmSync(!bpmSync)}
                  title="When on, the detected tempo drives the global BPM (and the loopers)"
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                    bpmSync
                      ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                      : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
                  }`}
                >
                  Sync BPM
                </button>
                <span
                  className={`text-[9px] font-semibold ${m.bpmStable ? 'text-emerald-400' : 'text-neutral-600'}`}
                  title="Lit when the detected tempo is steady enough to trust"
                >
                  ● stable
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Per-deck post-routing */}
        <section className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">
            Deck response
          </span>
          <div className="flex items-end gap-2">
            {fx.map((deck, i) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <VBar value={m.deckLevels[i] ?? 0} color="#38bdf8" height={48} />
                <span className="text-[8px] font-bold leading-none text-neutral-300">
                  {SCENE_LETTERS[sceneOfSlot(i)]}
                  {(i % CHANNELS) + 1}
                </span>
                <span className="text-[7px] leading-none text-neutral-500">{BAND_LABEL[deck.band]}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Per-layer detection rows */}
      <section className="flex flex-col gap-1">
        <span className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">
          Beat layers — each detects independently; enable feeds the combined beat
        </span>
        <div className="flex flex-col gap-2">
          {LAYERS.map((layer, i) => {
            const band = beatBands[i];
            if (!band) return null;
            return (
              <div
                key={layer.label}
                className="flex items-center gap-3 rounded border border-neutral-800 bg-neutral-950/60 px-2 py-1"
              >
                <div className="flex w-16 items-center gap-2">
                  <span
                    aria-hidden
                    className="h-3 w-3 rounded-full"
                    style={{
                      background: layer.color,
                      opacity: 0.2 + m[layer.meter] * 0.8,
                      transform: `scale(${0.7 + m[layer.meter] * 0.5})`,
                    }}
                  />
                  <span className="text-[10px] font-bold tracking-wider text-neutral-300">
                    {layer.label}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onBeatBandChange(i, 'enabled', !band.enabled)}
                  title="Feed this layer into the combined beat (and BPM strip)"
                  className={`rounded px-2 py-0.5 text-[9px] font-semibold transition-colors ${
                    band.enabled
                      ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {band.enabled ? 'ON' : 'OFF'}
                </button>
                <Knob
                  label="SENS"
                  value={band.sensitivity}
                  min={0.5}
                  max={3}
                  defaultValue={layer.sensDef}
                  format={(v) => `${v.toFixed(2)}x`}
                  onChange={(v) => onBeatBandChange(i, 'sensitivity', v)}
                />
                <Knob
                  label="GAP"
                  value={band.gapMs}
                  min={60}
                  max={500}
                  defaultValue={layer.gapDef}
                  format={(v) => `${Math.round(v)}ms`}
                  onChange={(v) => onBeatBandChange(i, 'gapMs', v)}
                />
                <Knob
                  label="DECAY"
                  value={band.decay}
                  min={0.02}
                  max={0.5}
                  defaultValue={layer.decayDef}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) => onBeatBandChange(i, 'decay', v)}
                />
                <Knob
                  label="FROM"
                  value={band.fromHz}
                  min={layer.fromHz.min}
                  max={layer.fromHz.max}
                  defaultValue={layer.fromHz.def}
                  format={fmtHz}
                  onChange={(v) => onBeatBandChange(i, 'fromHz', v)}
                />
                <Knob
                  label="TO"
                  value={band.toHz}
                  min={layer.toHz.min}
                  max={layer.toHz.max}
                  defaultValue={layer.toHz.def}
                  format={fmtHz}
                  onChange={(v) => onBeatBandChange(i, 'toHz', v)}
                />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
