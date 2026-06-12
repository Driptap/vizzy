import { useCallback, useState } from 'react';
import {
  CHANNELS,
  SLOTS,
  INITIAL_OPACITIES,
  DEFAULT_FX,
  makeDefaultAut,
  sceneOfSlot,
} from '../lib/channels';
import type {
  AutEffectKey,
  AutomationMap,
  ChannelFx,
  ChannelPos,
  ChannelSize,
  DeckChannelConfig,
  DeckStatus,
  DeckUiState,
  SessionSnapshot,
  SourceType,
} from '../types';

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
  const [fx, setFx] = useState<ChannelFx[]>(() =>
    Array.from({ length: SLOTS }, () => ({ ...DEFAULT_FX })),
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

  const applyCrossfade = useCallback((value: number) => {
    setCrossfade(value);
  }, []);

  const applyFx = useCallback(
    <K extends keyof ChannelFx>(slot: number, key: K, value: ChannelFx[K]) => {
      setFx((prev) => prev.map((f, i) => (i === slot ? { ...f, [key]: value } : f)));
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
    setFx((prev) => prev.map((v, i) => (i === slot ? { ...DEFAULT_FX } : v)));
    setAut((prev) => prev.map((v, i) => (i === slot ? makeDefaultAut() : v)));
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
    setFx((prev) => forScene(prev, (c, v) => ({ ...DEFAULT_FX, ...(c.fx ?? v) })));
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
    setFx(perSlot((s) => ({ ...DEFAULT_FX, ...(s.fx || {}) }), () => ({ ...DEFAULT_FX })));
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
    fx,
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
    applyCrossfade,
    applyFx,
    applyAut,
    setSourceType,
    resetChannelConfig,
    applyChannelConfigs,
    restoreFromSession,
  };
}
