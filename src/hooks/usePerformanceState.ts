import { useCallback, useState } from 'react';
import {
  CHANNELS,
  SLOTS,
  INITIAL_OPACITIES,
  DEFAULT_FX,
  DEFAULT_FILTER,
  DEFAULT_LIGHT,
  DEFAULT_LAYER,
  makeDefaultAut,
  sceneOfSlot,
} from '../lib/channels';
import { defaultLoop } from '../lib/loopControls';
import type {
  AutEffectKey,
  AutomationMap,
  BeatBandConfig,
  ChannelFilter,
  ChannelFx,
  ChannelLight,
  ChannelPos,
  ChannelSize,
  DeckChannelConfig,
  DeckLoop,
  DeckStatus,
  DeckUiState,
  SessionSnapshot,
  SourceType,
} from '../types';

const DEFAULT_BPM = 120;
// Per-layer beat-detector defaults [kick, snare, hat] — mirror BeatConfig::default
// in src-tauri/src/audio.rs. Calm by default: only the kick feeds the combined beat.
const DEFAULT_BEAT_BANDS: BeatBandConfig[] = [
  { enabled: true, sensitivity: 1.3, decay: 0.12, gapMs: 120, fromHz: 30, toHz: 150 },
  { enabled: false, sensitivity: 1.6, decay: 0.14, gapMs: 110, fromHz: 200, toHz: 2000 },
  { enabled: false, sensitivity: 1.9, decay: 0.1, gapMs: 80, fromHz: 3000, toHz: 8000 },
];
const cloneBeatBands = (b: BeatBandConfig[]): BeatBandConfig[] => b.map((x) => ({ ...x }));

export type PerformanceState = ReturnType<typeof usePerformanceState>;

// The whole mixer/deck performance state: parallel per-slot arrays plus the
// crossfader and cue selection. All appliers are stable callbacks.
export function usePerformanceState() {
  const [decks, setDecks] = useState<DeckUiState[]>(() =>
    Array.from({ length: SLOTS }, () => ({ status: 'idle', error: null })),
  );
  const [prompts, setPrompts] = useState<string[]>(() => Array(SLOTS).fill(''));
  const [opacities, setOpacities] = useState<number[]>(INITIAL_OPACITIES);
  const [muted, setMuted] = useState<boolean[]>(() => Array(SLOTS).fill(false));
  const [scales, setScales] = useState<number[]>(() => Array(SLOTS).fill(1));
  const [sizes, setSizes] = useState<ChannelSize[]>(() =>
    Array.from({ length: SLOTS }, () => ({ x: 1, y: 1 })),
  );
  const [positions, setPositions] = useState<ChannelPos[]>(() =>
    Array.from({ length: SLOTS }, () => ({ x: 0, y: 0 })),
  );
  const [lights, setLights] = useState<ChannelLight[]>(() =>
    Array.from({ length: SLOTS }, () => ({ ...DEFAULT_LIGHT })),
  );
  const [layers, setLayers] = useState<number[]>(() => Array(SLOTS).fill(DEFAULT_LAYER));
  const [loops, setLoops] = useState<DeckLoop[]>(() =>
    Array.from({ length: SLOTS }, defaultLoop),
  );
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  // When on, the native beat detector's tempo drives the global BPM (and thus
  // the looper). `beatBands` tunes the three detection layers live.
  const [bpmSync, setBpmSync] = useState(false);
  const [beatBands, setBeatBands] = useState<BeatBandConfig[]>(() =>
    cloneBeatBands(DEFAULT_BEAT_BANDS),
  );
  const [fx, setFx] = useState<ChannelFx[]>(() =>
    Array.from({ length: SLOTS }, () => ({ ...DEFAULT_FX })),
  );
  const [filters, setFilters] = useState<ChannelFilter[]>(() =>
    Array.from({ length: SLOTS }, () => ({ ...DEFAULT_FILTER })),
  );
  const [aut, setAut] = useState<AutomationMap[]>(() =>
    Array.from({ length: SLOTS }, makeDefaultAut),
  );
  const [sourceTypes, setSourceTypes] = useState<SourceType[]>(() =>
    Array(SLOTS).fill('shader'),
  );
  const [crossfade, setCrossfade] = useState(0);
  const [cueScene, setCueScene] = useState(0);

  const setDeckState = useCallback(
    (slot: number, status: DeckStatus, error: string | null = null) => {
      setDecks((prev) => prev.map((d, i) => (i === slot ? { status, error } : d)));
    },
    [],
  );

  const setPrompt = useCallback((slot: number, text: string) => {
    setPrompts((prev) => prev.map((p, i) => (i === slot ? text : p)));
  }, []);

  const applyOpacity = useCallback((slot: number, value: number) => {
    setOpacities((prev) => prev.map((v, i) => (i === slot ? value : v)));
  }, []);

  const toggleMute = useCallback((slot: number) => {
    setMuted((prev) => prev.map((m, i) => (i === slot ? !m : m)));
  }, []);

  const applyScale = useCallback((slot: number, value: number) => {
    setScales((prev) => prev.map((v, i) => (i === slot ? value : v)));
  }, []);

  const applySize = useCallback((slot: number, axis: 'x' | 'y', value: number) => {
    setSizes((prev) => prev.map((s, i) => (i === slot ? { ...s, [axis]: value } : s)));
  }, []);

  const applyPos = useCallback((slot: number, axis: 'x' | 'y', value: number) => {
    setPositions((prev) => prev.map((p, i) => (i === slot ? { ...p, [axis]: value } : p)));
  }, []);

  const applyLight = useCallback(
    (slot: number, key: keyof ChannelLight, value: number) => {
      setLights((prev) => prev.map((l, i) => (i === slot ? { ...l, [key]: value } : l)));
    },
    [],
  );

  const applyLayer = useCallback((slot: number, layer: number) => {
    setLayers((prev) => prev.map((v, i) => (i === slot ? layer : v)));
  }, []);

  const applyLoop = useCallback((slot: number, loop: DeckLoop) => {
    setLoops((prev) => prev.map((l, i) => (i === slot ? loop : l)));
  }, []);

  const applyBpm = useCallback((value: number) => {
    setBpm(Math.min(220, Math.max(40, Math.round(value) || DEFAULT_BPM)));
  }, []);

  const applyBpmSync = useCallback((on: boolean) => {
    setBpmSync(on);
  }, []);

  // Update one field of one beat layer, clamped to its valid range.
  const applyBeatBand = useCallback(
    <K extends keyof BeatBandConfig>(index: number, key: K, value: BeatBandConfig[K]) => {
      setBeatBands((prev) =>
        prev.map((band, i) => {
          if (i !== index) return band;
          let v = value;
          if (typeof v === 'number') {
            const clamp = (lo: number, hi: number) => Math.min(hi, Math.max(lo, v as number));
            if (key === 'sensitivity') v = clamp(0.5, 3) as BeatBandConfig[K];
            else if (key === 'decay') v = clamp(0.02, 0.5) as BeatBandConfig[K];
            else if (key === 'gapMs') v = clamp(60, 500) as BeatBandConfig[K];
            else if (key === 'fromHz') v = clamp(20, 16000) as BeatBandConfig[K];
            else if (key === 'toHz') v = clamp(20, 16000) as BeatBandConfig[K];
          }
          return { ...band, [key]: v };
        }),
      );
    },
    [],
  );

  const applyCrossfade = useCallback((value: number) => {
    setCrossfade(value);
  }, []);

  const applyFx = useCallback(
    <K extends keyof ChannelFx>(slot: number, key: K, value: ChannelFx[K]) => {
      setFx((prev) => prev.map((f, i) => (i === slot ? { ...f, [key]: value } : f)));
    },
    [],
  );

  const applyFilter = useCallback(
    <K extends keyof ChannelFilter>(slot: number, key: K, value: ChannelFilter[K]) => {
      setFilters((prev) => prev.map((f, i) => (i === slot ? { ...f, [key]: value } : f)));
    },
    [],
  );

  const applyAut = useCallback(
    (slot: number, effect: AutEffectKey, field: 'amt' | 'audio', value: number | boolean) => {
      setAut((prev) =>
        prev.map((a, i) =>
          i === slot ? { ...a, [effect]: { ...a[effect], [field]: value } } : a,
        ),
      );
    },
    [],
  );

  const setSourceType = useCallback((slot: number, type: SourceType) => {
    setSourceTypes((prev) => prev.map((s, i) => (i === slot ? type : s)));
  }, []);

  // Back to neutral knobs — scale, footprint, fx and automation — while the
  // staged visual, the prompt and the mixer fader/mute stay put.
  const resetChannelConfig = useCallback((slot: number) => {
    setScales((prev) => prev.map((v, i) => (i === slot ? 1 : v)));
    setSizes((prev) => prev.map((v, i) => (i === slot ? { x: 1, y: 1 } : v)));
    setPositions((prev) => prev.map((v, i) => (i === slot ? { x: 0, y: 0 } : v)));
    setLights((prev) => prev.map((v, i) => (i === slot ? { ...DEFAULT_LIGHT } : v)));
    setLayers((prev) => prev.map((v, i) => (i === slot ? DEFAULT_LAYER : v)));
    setLoops((prev) => prev.map((v, i) => (i === slot ? defaultLoop() : v)));
    setFx((prev) => prev.map((v, i) => (i === slot ? { ...DEFAULT_FX } : v)));
    setFilters((prev) => prev.map((v, i) => (i === slot ? { ...DEFAULT_FILTER } : v)));
    setAut((prev) => prev.map((v, i) => (i === slot ? makeDefaultAut() : v)));
  }, []);

  // The whole rig back to boot state: every slot blank, mixer neutral.
  const resetPerformance = useCallback(() => {
    setDecks(Array.from({ length: SLOTS }, () => ({ status: 'idle', error: null })));
    setPrompts(Array(SLOTS).fill(''));
    setOpacities([...INITIAL_OPACITIES]);
    setMuted(Array(SLOTS).fill(false));
    setScales(Array(SLOTS).fill(1));
    setSizes(Array.from({ length: SLOTS }, () => ({ x: 1, y: 1 })));
    setPositions(Array.from({ length: SLOTS }, () => ({ x: 0, y: 0 })));
    setLights(Array.from({ length: SLOTS }, () => ({ ...DEFAULT_LIGHT })));
    setLayers(Array(SLOTS).fill(DEFAULT_LAYER));
    setLoops(Array.from({ length: SLOTS }, defaultLoop));
    setFx(Array.from({ length: SLOTS }, () => ({ ...DEFAULT_FX })));
    setFilters(Array.from({ length: SLOTS }, () => ({ ...DEFAULT_FILTER })));
    setAut(Array.from({ length: SLOTS }, makeDefaultAut));
    setSourceTypes(Array(SLOTS).fill('shader'));
    setCrossfade(0);
    setCueScene(0);
    setBpm(DEFAULT_BPM);
    setBpmSync(false);
    setBeatBands(cloneBeatBands(DEFAULT_BEAT_BANDS));
  }, []);

  // Overlay a deck preset's channel configs onto one scene's slots; fields a
  // config doesn't carry keep their current value.
  const applyChannelConfigs = useCallback((scene: number, channels: DeckChannelConfig[]) => {
    const forScene = <T,>(prev: T[], getValue: (cfg: DeckChannelConfig, current: T) => T): T[] =>
      prev.map((value, i) => {
        if (sceneOfSlot(i) !== scene) return value;
        const cfg = channels[i % CHANNELS];
        return cfg ? getValue(cfg, value) : value;
      });
    setOpacities((prev) => forScene(prev, (c, v) => c.opacity ?? v));
    setMuted((prev) => forScene(prev, (c, v) => c.muted ?? v));
    setScales((prev) => forScene(prev, (c, v) => c.scale ?? v));
    setSizes((prev) => forScene(prev, (c, v) => (c.size ? { ...c.size } : v)));
    setPositions((prev) => forScene(prev, (c, v) => (c.pos ? { ...c.pos } : v)));
    setLights((prev) => forScene(prev, (c, v) => ({ ...DEFAULT_LIGHT, ...(c.light ?? v) })));
    setLayers((prev) => forScene(prev, (c, v) => c.layer ?? v));
    setLoops((prev) =>
      forScene(prev, (c, v) => (c.loop ? structuredClone(c.loop) : v)),
    );
    setFx((prev) => forScene(prev, (c, v) => ({ ...DEFAULT_FX, ...(c.fx ?? v) })));
    setFilters((prev) => forScene(prev, (c, v) => ({ ...DEFAULT_FILTER, ...(c.filter ?? v) })));
    setAut((prev) =>
      forScene(prev, (c, v) =>
        c.aut ? { ...makeDefaultAut(), ...structuredClone(c.aut) } : v,
      ),
    );
    setPrompts((prev) => forScene(prev, (c, v) => c.prompt ?? v));
  }, []);

  // Put back every slot's config from a session snapshot (missing slots get
  // their boot defaults).
  const restoreFromSession = useCallback((session: SessionSnapshot) => {
    const perSlot = <T,>(
      fromSlot: (slot: SessionSnapshot['slots'][number]) => T,
      fallback: (index: number) => T,
    ): T[] =>
      Array.from({ length: SLOTS }, (_, i) =>
        session.slots[i] ? fromSlot(session.slots[i]) : fallback(i),
      );
    setPrompts(perSlot((s) => s.prompt ?? '', () => ''));
    setOpacities(perSlot((s) => s.opacity ?? 0, (i) => INITIAL_OPACITIES[i]));
    setMuted(perSlot((s) => Boolean(s.muted), () => false));
    setScales(perSlot((s) => s.scale ?? 1, () => 1));
    setSizes(perSlot((s) => ({ x: 1, y: 1, ...(s.size || {}) }), () => ({ x: 1, y: 1 })));
    setPositions(perSlot((s) => ({ x: 0, y: 0, ...(s.pos || {}) }), () => ({ x: 0, y: 0 })));
    setLights(perSlot((s) => ({ ...DEFAULT_LIGHT, ...(s.light || {}) }), () => ({ ...DEFAULT_LIGHT })));
    setLayers(perSlot((s) => s.layer ?? DEFAULT_LAYER, () => DEFAULT_LAYER));
    setLoops(
      perSlot((s) => (s.loop ? { ...defaultLoop(), ...structuredClone(s.loop) } : defaultLoop()), defaultLoop),
    );
    setBpm(session.bpm ?? DEFAULT_BPM);
    setBpmSync(session.bpmSync ?? false);
    setBeatBands(
      session.beatBands?.length === DEFAULT_BEAT_BANDS.length
        ? session.beatBands.map((b, i) => ({ ...DEFAULT_BEAT_BANDS[i], ...b }))
        : cloneBeatBands(DEFAULT_BEAT_BANDS),
    );
    setFx(perSlot((s) => ({ ...DEFAULT_FX, ...(s.fx || {}) }), () => ({ ...DEFAULT_FX })));
    setFilters(
      perSlot((s) => ({ ...DEFAULT_FILTER, ...(s.filter || {}) }), () => ({ ...DEFAULT_FILTER })),
    );
    setAut(perSlot((s) => ({ ...makeDefaultAut(), ...(s.aut || {}) }), makeDefaultAut));
    setCrossfade(session.crossfade ?? 0);
    setCueScene(session.cueScene ?? 0);
  }, []);

  return {
    decks,
    prompts,
    opacities,
    muted,
    scales,
    sizes,
    positions,
    lights,
    layers,
    loops,
    bpm,
    bpmSync,
    beatBands,
    fx,
    filters,
    aut,
    sourceTypes,
    crossfade,
    cueScene,
    setCueScene,
    setDeckState,
    setPrompt,
    applyOpacity,
    toggleMute,
    applyScale,
    applySize,
    applyPos,
    applyLight,
    applyLayer,
    applyLoop,
    applyBpm,
    applyBpmSync,
    applyBeatBand,
    applyCrossfade,
    applyFx,
    applyFilter,
    applyAut,
    setSourceType,
    resetChannelConfig,
    resetPerformance,
    applyChannelConfigs,
    restoreFromSession,
  };
}
