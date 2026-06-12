import { useCallback, useEffect, useState } from 'react';
import {
  listShaders,
  saveShader,
  saveDeck,
  saveModel,
  saveSprite,
  filePathOf,
  renameShader,
  updateEntry,
  deleteEntry,
  hasSeededMarker,
  writeSeededMarker,
} from '../lib/shaderLibrary';
import { makeSpriteThumbnail } from '../lib/spriteLoader';
import { stageSource, resolveSourceRef } from '../lib/sourceStaging';
import {
  seedExampleLibrary,
  dedupeExampleEntries,
  EXAMPLE_DECK_NAME,
} from '../lib/exampleSeed';
import { getStored, setStored } from '../lib/storage';
import { CHANNELS, slotIndex } from '../lib/channels';
import type {
  DeckChannelConfig,
  DeckEntry,
  LibraryEntry,
  ModelEntry,
  SessionSnapshot,
  ShaderEntry,
  SpriteEntry,
  StageableSource,
} from '../types';
import type { EngineRef } from './useEngineRig';
import type { PerformanceState } from './usePerformanceState';

interface LibraryOptions {
  engineRef: EngineRef;
  perf: PerformanceState;
  restoreSession: (session: SessionSnapshot, entries: LibraryEntry[]) => void;
  loadSavedSession: () => Promise<SessionSnapshot | null>;
  markSessionReady: () => void;
}

export const isShaderEntry = (e: LibraryEntry): e is ShaderEntry => !e.kind;

// The shader/deck/model/sprite library: list state, every library action, and
// the boot sequence (first-run example seeding or session restore).
export function useLibrary({ engineRef, perf, restoreSession, loadSavedSession, markSessionReady }: LibraryOptions) {
  const {
    cueScene,
    prompts,
    opacities,
    muted,
    scales,
    sizes,
    fx,
    aut,
    setDeckState,
    setSourceType,
    applyChannelConfigs,
  } = perf;

  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(() => getStored('libraryOpen') === '1');

  const handleToggleLibrary = useCallback(() => {
    setLibraryOpen((prev) => {
      setStored('libraryOpen', prev ? '0' : '1');
      return !prev;
    });
  }, []);

  // Stage a resolved source onto a slot with status bookkeeping.
  const stageOntoSlot = useCallback(
    async (slot: number, source: StageableSource) => {
      setDeckState(slot, 'compiling');
      const result = await stageSource(engineRef.current!, slot, source);
      if (result.ok) {
        setDeckState(slot, 'active');
        setSourceType(slot, source.type);
      } else {
        setDeckState(slot, 'failed', result.error);
      }
      return result;
    },
    [engineRef, setDeckState, setSourceType],
  );

  // ---- channel actions (channel 0-3 -> slot via the cued scene) ----

  const handleSaveDeck = useCallback(
    async (channel: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      const slot = slotIndex(cueScene, channel);
      // model/sprite channels have no shader to save; they're already library entries
      if (engine.getChannelSource(slot).type !== 'shader') return;
      try {
        const entry = await saveShader({
          code: engine.getShaderBody(slot),
          screenshot: engine.getPreviewDataURL(channel),
        });
        setLibrary((prev) => [entry, ...prev]);
      } catch (err) {
        console.error('[Vizzy] Saving shader failed:', err);
      }
    },
    [engineRef, cueScene],
  );

  const handleAddModels = useCallback(async (files: File[]) => {
    try {
      const added: LibraryEntry[] = [];
      for (const file of files) {
        const sourcePath = filePathOf(file);
        const name = file.name.replace(/\.[^.]+$/, '');
        // eslint-disable-next-line no-await-in-loop
        added.push(await saveModel({ sourcePath, name }));
      }
      setLibrary((prev) => [...added, ...prev]);
    } catch (err) {
      console.error('[Vizzy] Adding model failed:', err);
    }
  }, []);

  const handleAddSprites = useCallback(async (files: File[]) => {
    try {
      const added: LibraryEntry[] = [];
      for (const file of files) {
        const sourcePath = filePathOf(file);
        const name = file.name.replace(/\.[^.]+$/, '');
        // eslint-disable-next-line no-await-in-loop
        const screenshot = await makeSpriteThumbnail(sourcePath);
        // eslint-disable-next-line no-await-in-loop
        added.push(await saveSprite({ sourcePath, name, screenshot }));
      }
      setLibrary((prev) => [...added, ...prev]);
    } catch (err) {
      console.error('[Vizzy] Adding sprite failed:', err);
    }
  }, []);

  const handleAssignSprite = useCallback(
    (entry: SpriteEntry, channel: number) => stageOntoSlot(slotIndex(cueScene, channel), { type: 'sprite', entry }),
    [stageOntoSlot, cueScene],
  );

  const handleAssignModel = useCallback(
    async (entry: ModelEntry, channel: number) => {
      const result = await stageOntoSlot(slotIndex(cueScene, channel), { type: 'model', entry });
      // first assign captures a thumbnail once the preview has the model
      if (result.ok && !entry.screenshot) {
        setTimeout(async () => {
          const shot = engineRef.current?.getPreviewDataURL(channel);
          if (!shot) return;
          const updated = await updateEntry({ ...entry, screenshot: shot });
          setLibrary((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
        }, 700);
      }
    },
    [stageOntoSlot, engineRef, cueScene],
  );

  const handleAddToChannel = useCallback(
    (entry: ShaderEntry, channel: number) =>
      stageOntoSlot(slotIndex(cueScene, channel), { type: 'shader', code: entry.code }),
    [stageOntoSlot, cueScene],
  );

  // Save the cued scene as a deck preset. Channels whose shader code isn't in
  // the library yet get saved as (unnamed) shader entries first; the deck
  // references shaders by id and carries each channel's full config.
  const handleSaveDeckScene = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const scene = cueScene;
    try {
      const newShaders: ShaderEntry[] = [];
      const channels: DeckChannelConfig[] = [];
      for (let ch = 0; ch < CHANNELS; ch += 1) {
        const slot = slotIndex(scene, ch);
        const config = {
          prompt: prompts[slot],
          opacity: opacities[slot],
          muted: muted[slot],
          scale: scales[slot],
          size: { ...sizes[slot] },
          fx: { ...fx[slot] },
          aut: structuredClone(aut[slot]),
        };
        const source = engine.getChannelSource(slot);
        if (source.type === 'model') {
          channels.push({ modelId: source.modelId, ...config });
        } else if (source.type === 'sprite') {
          channels.push({ spriteId: source.spriteId, ...config });
        } else {
          let shaderEntry =
            library.find((e) => isShaderEntry(e) && e.code === source.code) ||
            newShaders.find((e) => e.code === source.code);
          if (!shaderEntry) {
            // eslint-disable-next-line no-await-in-loop
            shaderEntry = await saveShader({
              code: source.code ?? '',
              screenshot: engine.getPreviewDataURL(ch),
            });
            newShaders.push(shaderEntry);
          }
          channels.push({ shaderId: shaderEntry.id, ...config });
        }
      }
      const deckEntry = await saveDeck({ channels, screenshot: engine.getSceneDataURL(scene) });
      setLibrary((prev) => [deckEntry, ...newShaders, ...prev]);
    } catch (err) {
      console.error('[Vizzy] Saving deck preset failed:', err);
    }
  }, [engineRef, cueScene, library, prompts, opacities, muted, scales, sizes, fx, aut]);

  // Load a deck preset into scene A or B: stage all 4 channels and restore
  // each channel's config; the engine sync effect pushes it down. Takes the
  // entry list explicitly so the first-run seeder can call it before the
  // library state has settled.
  const assignDeckEntry = useCallback(
    (entry: DeckEntry, scene: number, entries: LibraryEntry[]) => {
      if (!engineRef.current) return;
      const byId = new Map(entries.map((e) => [e.id, e]));
      entry.channels.forEach((cfg, ch) => {
        const slot = slotIndex(scene, ch);
        const { source, error } = resolveSourceRef(cfg, byId);
        if (source) stageOntoSlot(slot, source);
        else setDeckState(slot, 'failed', error);
      });
      applyChannelConfigs(scene, entry.channels);
    },
    [engineRef, stageOntoSlot, setDeckState, applyChannelConfigs],
  );

  const handleAssignDeck = useCallback(
    (entry: DeckEntry, scene: number) => assignDeckEntry(entry, scene, library),
    [assignDeckEntry, library],
  );

  const handleDeleteEntry = useCallback(async (entry: LibraryEntry) => {
    await deleteEntry(entry);
    setLibrary((prev) => prev.filter((e) => e.id !== entry.id));
  }, []);

  const handleRenameShader = useCallback(async (entry: LibraryEntry, name: string) => {
    try {
      const updated = await renameShader(entry, name);
      setLibrary((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } catch (err) {
      console.error('[Vizzy] Renaming shader failed:', err);
    }
  }, []);

  // Boot: load the library, then either seed the first-run example content
  // onto scene A or restore the previous session.
  useEffect(() => {
    (async () => {
      try {
        let entries = await dedupeExampleEntries(await listShaders());
        // First launch only: create the example content and put it on scene A.
        // The marker is a FILE in userData (localStorage is per-origin, so it
        // alone re-seeded when switching between dev server and built app);
        // an existing Example Deck also counts as already-seeded.
        const alreadySeeded =
          (await hasSeededMarker()) ||
          getStored('seeded') ||
          entries.some((e) => e.kind === 'deck' && e.name === EXAMPLE_DECK_NAME);
        if (!alreadySeeded) {
          const { deck, entries: seeded } = await seedExampleLibrary();
          await writeSeededMarker();
          setStored('seeded', '1');
          entries = [...seeded, ...entries];
          setLibrary(entries);
          assignDeckEntry(deck, 0, entries);
        } else {
          await writeSeededMarker(); // heal installs that only had the localStorage flag
          setLibrary(entries);
          const session = await loadSavedSession();
          if (session) restoreSession(session, entries);
        }
      } catch (err) {
        console.warn('[Vizzy] Could not load shader library:', err);
      } finally {
        markSessionReady();
      }
    })();
  }, [assignDeckEntry, restoreSession, loadSavedSession, markSessionReady]);

  return {
    library,
    libraryOpen,
    handleToggleLibrary,
    handleSaveDeck,
    handleAddModels,
    handleAddSprites,
    handleAssignSprite,
    handleAssignModel,
    handleAddToChannel,
    handleSaveDeckScene,
    handleAssignDeck,
    handleDeleteEntry,
    handleRenameShader,
  };
}
