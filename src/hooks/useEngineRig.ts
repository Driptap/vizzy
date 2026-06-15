import { useEffect, useRef, type RefObject } from 'react';
import { NativeRenderEngine } from '../engine/NativeRenderEngine';
import { NativeAudioEngine } from '../engine/NativeAudioEngine';
import { GenerationQueue, type DeckStatusCallback } from '../llm/ollama';
import type { PerformanceState } from './usePerformanceState';

export type EngineRef = RefObject<NativeRenderEngine | null>;

interface EngineRigOptions {
  sceneACanvasRef: RefObject<HTMLCanvasElement | null>;
  sceneBCanvasRef: RefObject<HTMLCanvasElement | null>;
  previewRefs: RefObject<(HTMLCanvasElement | null)[]>;
  getModel: () => string;
  onDeckStatus: DeckStatusCallback;
}

// Owns the hardware-facing singletons: the render-engine client, the native
// audio engine (UI meters; the render core reads audio in-process), and the
// LLM generation queue. Created once on mount; callbacks are routed through
// refs so the rig never needs re-creating.
export function useEngineRig({
  sceneACanvasRef,
  sceneBCanvasRef,
  previewRefs,
  getModel,
  onDeckStatus,
}: EngineRigOptions) {
  const engineRef = useRef<NativeRenderEngine | null>(null);
  const audioRef = useRef<NativeAudioEngine | null>(null);
  const queueRef = useRef<GenerationQueue | null>(null);

  const getModelRef = useRef(getModel);
  getModelRef.current = getModel;
  const onDeckStatusRef = useRef(onDeckStatus);
  onDeckStatusRef.current = onDeckStatus;

  useEffect(() => {
    const audio = new NativeAudioEngine();
    audioRef.current = audio;

    const engine = new NativeRenderEngine(
      { a: sceneACanvasRef.current, b: sceneBCanvasRef.current },
      previewRefs.current,
    );
    engineRef.current = engine;

    queueRef.current = new GenerationQueue({
      getModel: () => getModelRef.current(),
      onStatus: (slot, status, error) => onDeckStatusRef.current(slot, status, error),
    });

    return () => {
      engine.dispose();
      audio.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { engineRef, audioRef, queueRef };
}

// Single sync point for the engine state: a muted channel outputs 0
// while its fader position is preserved for unmute.
export function useEngineSync(
  engineRef: EngineRef,
  { opacities, muted, scales, sizes, positions, lights, layers, loops, bpm, fx, filters, aut, crossfade, cueScene }: PerformanceState,
): void {
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    opacities.forEach((value, i) => engine.setOpacity(i, muted[i] ? 0 : value));
    scales.forEach((value, i) => engine.setScale(i, value));
    sizes.forEach((size, i) => engine.setSize(i, size.x, size.y));
    positions.forEach((pos, i) => engine.setPosition(i, pos.x, pos.y));
    lights.forEach((l, i) => engine.setLighting(i, l.brightness, (l.angle * Math.PI) / 180));
    layers.forEach((layer, i) => engine.setLayer(i, layer));
    loops.forEach((loop, i) => engine.setLoop(i, loop));
    engine.setBpm(bpm);
    fx.forEach((f, i) => {
      engine.setChannelFx(i, (f.tilt * Math.PI) / 180, f.contrast, (f.hue * Math.PI) / 180, f.sat);
      engine.setAudioRouting(i, f.band, f.amt);
    });
    filters.forEach((f, i) => engine.setFilter(i, f.kind, f.amount, f.param2));
    aut.forEach((a, i) => engine.setAutomation(i, a));
    engine.setCrossfade(crossfade);
  }, [engineRef, opacities, muted, scales, sizes, positions, lights, layers, loops, bpm, fx, filters, aut, crossfade]);

  useEffect(() => {
    engineRef.current?.setCueScene(cueScene);
  }, [engineRef, cueScene]);
}
