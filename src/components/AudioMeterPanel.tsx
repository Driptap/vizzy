import { CHANNELS, SCENE_LETTERS, sceneOfSlot } from '../lib/channels';
import { useMeters, type MeterStore } from '../hooks/useAudioMeters';
import type { AudioBand, ChannelFx } from '../types';
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
};

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
  beatSensitivity: number;
  beatDecay: number;
  onSensitivityChange: (v: number) => void;
  onDecayChange: (v: number) => void;
}

/**
 * The expandable audio panel: per-band spectrum, a beat indicator, the detected
 * tempo with a sync toggle, the global beat-detector knobs, and the live
 * post-routing value each deck is receiving.
 */
export function AudioMeterPanel({
  store,
  fx,
  bpmSync,
  onToggleBpmSync,
  beatSensitivity,
  beatDecay,
  onSensitivityChange,
  onDecayChange,
}: Props) {
  const m = useMeters(store);
  return (
    <div className="flex items-stretch gap-6 overflow-x-auto border-b border-neutral-800 bg-neutral-900 px-4 py-3">
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

      {/* Beat + BPM */}
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

      {/* Detector tuning */}
      <section className="flex flex-col gap-1">
        <span className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">Detector</span>
        <div className="flex items-start gap-1">
          <Knob
            label="SENS"
            value={beatSensitivity}
            min={0.5}
            max={3}
            defaultValue={1.4}
            format={(v) => `${v.toFixed(2)}x`}
            onChange={onSensitivityChange}
          />
          <Knob
            label="DECAY"
            value={beatDecay}
            min={0.02}
            max={0.5}
            defaultValue={0.12}
            format={(v) => v.toFixed(2)}
            onChange={onDecayChange}
          />
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
  );
}
