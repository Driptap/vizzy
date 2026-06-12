import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_MODEL, resolveServer, listInstalledModels } from '../llm/ollama';
import { catalogEntry } from '../llm/models';
import { getStored, setStored } from '../lib/storage';

// LLM bootstrap: a reachable server with the chosen model means we're ready;
// anything else opens the setup overlay (which can also start/download a
// managed Ollama runtime).
export function useLlmSetup() {
  const modelRef = useRef(getStored('model') || DEFAULT_MODEL);
  const [model, setModel] = useState(modelRef.current);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [llmReady, setLlmReady] = useState(false);

  useEffect(() => {
    (async () => {
      const base = await resolveServer();
      if (base) {
        const tags = await listInstalledModels(base);
        setInstalledModels(tags);
        if (tags.includes(modelRef.current) || tags.includes(`${modelRef.current}:latest`)) {
          setLlmReady(true);
          return;
        }
      }
      setSetupOpen(true);
    })();
  }, []);

  const handleSetupReady = useCallback(async () => {
    setInstalledModels(await listInstalledModels());
    setLlmReady(true);
    setSetupOpen(false);
  }, []);

  const handleModelChange = useCallback(
    (value: string) => {
      setModel(value);
      modelRef.current = value;
      setStored('model', value);
      // picking a catalog model that isn't downloaded yet sends you through
      // the setup overlay's pull flow (it preselects this model)
      if (
        catalogEntry(value) &&
        !installedModels.includes(value) &&
        !installedModels.includes(`${value}:latest`)
      ) {
        setSetupOpen(true);
      }
    },
    [installedModels],
  );

  return {
    modelRef,
    model,
    installedModels,
    setupOpen,
    setSetupOpen,
    llmReady,
    handleSetupReady,
    handleModelChange,
  };
}
