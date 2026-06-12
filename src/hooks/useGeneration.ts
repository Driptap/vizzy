import { useCallback, useRef } from 'react';
import { extractShaderCode } from '../llm/parser';
import { SCENE_SYSTEM_PROMPT, parseSceneSpec } from '../llm/scenes';
import { buildSceneObject } from '../lib/sceneGenerator';
import { slotIndex } from '../lib/channels';

export type GenMode = 'shader' | 'scene';
import type { GenerationQueue, RepairContext } from '../llm/ollama';
import type { RefObject } from 'react';
import type { EngineRef } from './useEngineRig';
import type { PerformanceState } from './usePerformanceState';

interface GenerationOptions {
  engineRef: EngineRef;
  queueRef: RefObject<GenerationQueue | null>;
  cueScene: number;
  setDeckState: PerformanceState['setDeckState'];
  setSourceType: PerformanceState['setSourceType'];
}

// Prompt-to-shader flow: parse the raw LLM response, stage it on the engine,
// and keep the last failure per slot so Regenerate can ask for a repair.
export function useGeneration({ engineRef, queueRef, cueScene, setDeckState, setSourceType }: GenerationOptions) {
  // per-slot {code, error} of the last failed generation, fuels Regenerate
  const lastFailRef = useRef<Record<number, RepairContext>>({});

  const handleShaderResponse = useCallback(
    (slot: number, raw: string) => {
      const code = extractShaderCode(raw);
      if (!code) {
        const error = 'No GLSL main() block found in the model response';
        lastFailRef.current[slot] = { code: String(raw).trim().slice(0, 4000), error };
        setDeckState(slot, 'failed', error);
        return;
      }
      setDeckState(slot, 'compiling');
      const result = engineRef.current!.stageShader(slot, code);
      if (result.ok) {
        delete lastFailRef.current[slot];
        setDeckState(slot, 'active');
        setSourceType(slot, 'shader');
      } else {
        lastFailRef.current[slot] = { code, error: result.error };
        setDeckState(slot, 'failed', result.error);
      }
    },
    [engineRef, setDeckState, setSourceType],
  );

  const handleSceneResponse = useCallback(
    async (slot: number, raw: string) => {
      const parsed = parseSceneSpec(raw);
      if (!parsed.spec) {
        lastFailRef.current[slot] = { code: String(raw).trim().slice(0, 4000), error: parsed.error };
        setDeckState(slot, 'failed', parsed.error);
        return;
      }
      setDeckState(slot, 'compiling');
      try {
        const object = buildSceneObject(parsed.spec);
        await engineRef.current!.stageScene(slot, object, parsed.spec);
        delete lastFailRef.current[slot];
        setDeckState(slot, 'active');
        setSourceType(slot, 'scene');
      } catch (err) {
        const error = (err as Error).message || 'Scene build failed';
        lastFailRef.current[slot] = { code: String(raw).trim().slice(0, 4000), error };
        setDeckState(slot, 'failed', error);
      }
    },
    [engineRef, setDeckState, setSourceType],
  );

  const makeResponseHandler = useCallback(
    (slot: number, mode: GenMode) => (raw: string) => {
      if (mode === 'scene') handleSceneResponse(slot, raw);
      else handleShaderResponse(slot, raw);
    },
    [handleShaderResponse, handleSceneResponse],
  );

  const handleGenerate = useCallback(
    (channel: number, prompt: string, mode: GenMode = 'shader') => {
      const slot = slotIndex(cueScene, channel);
      queueRef.current?.enqueue(
        slot,
        prompt,
        makeResponseHandler(slot, mode),
        null,
        mode === 'scene' ? SCENE_SYSTEM_PROMPT : null,
      );
    },
    [queueRef, makeResponseHandler, cueScene],
  );

  // resend the prompt along with the failing code + error so the model can fix it
  const handleRegenerate = useCallback(
    (channel: number, prompt: string, mode: GenMode = 'shader') => {
      const slot = slotIndex(cueScene, channel);
      queueRef.current?.enqueue(
        slot,
        prompt,
        makeResponseHandler(slot, mode),
        lastFailRef.current[slot] || null,
        mode === 'scene' ? SCENE_SYSTEM_PROMPT : null,
      );
    },
    [queueRef, makeResponseHandler, cueScene],
  );

  return { handleGenerate, handleRegenerate };
}
