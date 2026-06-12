import { useCallback, useRef } from 'react';
import { extractShaderCode } from '../llm/parser';
import { slotIndex } from '../lib/channels';
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

  const makeResponseHandler = useCallback(
    (slot: number) => (raw: string) => {
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

  const handleGenerate = useCallback(
    (channel: number, prompt: string) => {
      const slot = slotIndex(cueScene, channel);
      queueRef.current?.enqueue(slot, prompt, makeResponseHandler(slot));
    },
    [queueRef, makeResponseHandler, cueScene],
  );

  // resend the prompt along with the failing code + error so the model can fix it
  const handleRegenerate = useCallback(
    (channel: number, prompt: string) => {
      const slot = slotIndex(cueScene, channel);
      queueRef.current?.enqueue(
        slot,
        prompt,
        makeResponseHandler(slot),
        lastFailRef.current[slot] || null,
      );
    },
    [queueRef, makeResponseHandler, cueScene],
  );

  return { handleGenerate, handleRegenerate };
}
