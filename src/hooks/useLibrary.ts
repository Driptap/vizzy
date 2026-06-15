import { useCallback, useEffect, useState } from 'react';
import {
  listShaders,
  saveShader,
  saveScene,
  saveDeck,
  saveModel,
  saveSprite,
  saveVideo,
  renameShader,
  updateEntry,
  deleteEntry,
  hasSeededMarker,
  writeSeededMarker,
} from '../lib/shaderLibrary';
import { makeSpriteThumbnail } from '../lib/spriteLoader';
import { MODEL_EXTENSIONS, SPRITE_EXTENSIONS, VIDEO_EXTENSIONS } from '../lib/assetTypes';
import { getPlatform } from '../platform';
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
  SceneEntry,
  SessionSnapshot,
  ShaderEntry,
  SpriteEntry,
  StageableSource,
  VideoEntry,
} from '../types';
import type { EngineRef } from './useEngineRig';
import type { PerformanceState } from './usePerformanceState';

interface LibraryOptions {
  engineRef: EngineRef;
  perf: PerformanceState;
  restoreSession: (session: SessionSnapshot, entries: LibraryEntry[]) => Promise<void>;
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
    positions,
    lights,
    layers,
    loops,
    fx,
    filters,
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
      // model/sprite channels are already library entries; shaders and
      // generated scenes get captured here
      const source = engine.getChannelSource(slot);
      try {
        let entry: LibraryEntry;
        if (source.type === 'shader') {
          entry = await saveShader({
            patch: engine.getPatch(slot),
            screenshot: engine.getPreviewDataURL(channel),
          });
        } else if (source.type === 'scene') {
          entry = await saveScene({
            spec: source.spec,
            prompt: prompts[slot],
            screenshot: engine.getPreviewDataURL(channel),
          });
        } else {
          return;
        }
        setLibrary((prev) => [entry, ...prev]);
      } catch (err) {
        console.error('[Vizzy] Saving channel failed:', err);
      }
    },
    [engineRef, cueScene, prompts],
  );

  const addModelPaths = useCallback(async (items: Array<{ sourcePath: string; name: string }>) => {
    try {
      const added: LibraryEntry[] = [];
      for (const { sourcePath, name } of items) {
        // eslint-disable-next-line no-await-in-loop
        added.push(await saveModel({ sourcePath, name }));
      }
      setLibrary((prev) => [...added, ...prev]);
    } catch (err) {
      console.error('[Vizzy] Adding model failed:', err);
    }
  }, []);

  const addSpritePaths = useCallback(async (items: Array<{ sourcePath: string; name: string }>) => {
    try {
      const added: LibraryEntry[] = [];
      for (const { sourcePath, name } of items) {
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

  const addVideoPaths = useCallback(async (items: Array<{ sourcePath: string; name: string }>) => {
    try {
      const added: LibraryEntry[] = [];
      for (const { sourcePath, name } of items) {
        // eslint-disable-next-line no-await-in-loop
        added.push(await saveVideo({ sourcePath, name }));
      }
      setLibrary((prev) => [...added, ...prev]);
    } catch (err) {
      console.error('[Vizzy] Adding video failed:', err);
    }
  }, []);

  /** Route absolute paths (native drops / native picker) by extension. */
  const handleAddPaths = useCallback(
    async (paths: string[]) => {
      const item = (p: string) => ({
        sourcePath: p,
        name: (p.split(/[/\\]/).pop() ?? p).replace(/\.[^.]+$/, ''),
      });
      const matches = (p: string, exts: string[]) =>
        exts.some((ext) => p.toLowerCase().endsWith(ext));
      const models = paths.filter((p) => matches(p, MODEL_EXTENSIONS)).map(item);
      const sprites = paths.filter((p) => matches(p, SPRITE_EXTENSIONS)).map(item);
      const videos = paths.filter((p) => matches(p, VIDEO_EXTENSIONS)).map(item);
      if (models.length) await addModelPaths(models);
      if (sprites.length) await addSpritePaths(sprites);
      if (videos.length) await addVideoPaths(videos);
    },
    [addModelPaths, addSpritePaths, addVideoPaths],
  );

  // The webview swallows DOM drop events; file drops arrive as native paths.
  useEffect(() => getPlatform().onFileDrop((paths) => void handleAddPaths(paths)), [handleAddPaths]);

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

  const handleAssignVideo = useCallback(
    async (entry: VideoEntry, channel: number) => {
      const result = await stageOntoSlot(slotIndex(cueScene, channel), { type: 'video', entry });
      // capture a thumbnail from the rendered first frame on first assign
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
      stageOntoSlot(slotIndex(cueScene, channel), { type: 'shader', patch: entry.patch }),
    [stageOntoSlot, cueScene],
  );

  const handleAssignScene = useCallback(
    (entry: SceneEntry, channel: number) =>
      stageOntoSlot(slotIndex(cueScene, channel), { type: 'scene', spec: entry.spec }),
    [stageOntoSlot, cueScene],
  );

  // Same model entry, staged as fly-over terrain instead of a centered object.
  const handleAssignLandscape = useCallback(
    (entry: ModelEntry, channel: number) =>
      stageOntoSlot(slotIndex(cueScene, channel), { type: 'landscape', entry }),
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
      const newScenes: SceneEntry[] = [];
      const channels: DeckChannelConfig[] = [];
      for (let ch = 0; ch < CHANNELS; ch += 1) {
        const slot = slotIndex(scene, ch);
        const config = {
          prompt: prompts[slot],
          opacity: opacities[slot],
          muted: muted[slot],
          scale: scales[slot],
          size: { ...sizes[slot] },
          pos: { ...positions[slot] },
          light: { ...lights[slot] },
          layer: layers[slot],
          loop: structuredClone(loops[slot]),
          fx: { ...fx[slot] },
          filter: { ...filters[slot] },
          aut: structuredClone(aut[slot]),
        };
        const source = engine.getChannelSource(slot);
        if (source.type === 'model') {
          channels.push({ modelId: source.modelId, ...config });
        } else if (source.type === 'sprite') {
          channels.push({ spriteId: source.spriteId, ...config });
        } else if (source.type === 'video') {
          channels.push({ videoId: source.videoId, ...config });
        } else if (source.type === 'landscape') {
          channels.push({ landscapeId: source.modelId, ...config });
        } else if (source.type === 'scene') {
          const specJson = JSON.stringify(source.spec);
          let sceneEntry =
            library.find(
              (e): e is SceneEntry => e.kind === 'scene' && JSON.stringify(e.spec) === specJson,
            ) || newScenes.find((e) => JSON.stringify(e.spec) === specJson);
          if (!sceneEntry) {
            // eslint-disable-next-line no-await-in-loop
            sceneEntry = await saveScene({
              spec: source.spec,
              prompt: prompts[slot],
              screenshot: engine.getPreviewDataURL(ch),
            });
            newScenes.push(sceneEntry);
          }
          channels.push({ sceneId: sceneEntry.id, ...config });
        } else {
          const patchJson = JSON.stringify(source.patch);
          let shaderEntry =
            library.find(
              (e): e is ShaderEntry => isShaderEntry(e) && JSON.stringify(e.patch) === patchJson,
            ) || newShaders.find((e) => JSON.stringify(e.patch) === patchJson);
          if (!shaderEntry) {
            // eslint-disable-next-line no-await-in-loop
            shaderEntry = await saveShader({
              patch: source.patch,
              screenshot: engine.getPreviewDataURL(ch),
            });
            newShaders.push(shaderEntry);
          }
          channels.push({ shaderId: shaderEntry.id, ...config });
        }
      }
      const deckEntry = await saveDeck({ channels, screenshot: engine.getSceneDataURL(scene) });
      setLibrary((prev) => [deckEntry, ...newScenes, ...newShaders, ...prev]);
    } catch (err) {
      console.error('[Vizzy] Saving deck preset failed:', err);
    }
  }, [engineRef, cueScene, library, prompts, opacities, muted, scales, sizes, positions, lights, layers, loops, fx, filters, aut]);

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

  // Boot: load the library; on first launch seed the example content, then
  // restore the previous session if there is one. A saved session always wins
  // over the example deck so reopening the app puts you back where you were —
  // and autosave is enabled (markSessionReady) only after the restore has
  // finished staging, so a slow restore can't clobber the saved session.
  useEffect(() => {
    (async () => {
      try {
        let entries = await dedupeExampleEntries(await listShaders());
        const session = await loadSavedSession();
        if (session) {
          // A returning user: restore where they left off and never inject
          // example content. Awaited so autosave stays gated until staging
          // finishes and can't overwrite the saved session with empties.
          setLibrary(entries);
          await restoreSession(session, entries);
        } else {
          // No session. Seed the example content on genuine first launch only.
          // The marker is a FILE in userData; an existing Example Deck also
          // counts as already-seeded.
          const alreadySeeded =
            (await hasSeededMarker()) ||
            entries.some((e) => e.kind === 'deck' && e.name === EXAMPLE_DECK_NAME);
          if (!alreadySeeded) {
            const { deck, entries: seeded } = await seedExampleLibrary();
            entries = [...seeded, ...entries];
            setLibrary(entries);
            assignDeckEntry(deck, 0, entries);
          } else {
            setLibrary(entries);
          }
        }
        // Idempotent: also heals installs whose marker write previously failed
        // (the marker used to be a dotfile the fs scope silently rejected).
        await writeSeededMarker();
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
    handleAddPaths,
    handleAssignSprite,
    handleAssignVideo,
    handleAssignModel,
    handleAssignLandscape,
    handleAssignScene,
    handleAddToChannel,
    handleSaveDeckScene,
    handleAssignDeck,
    handleDeleteEntry,
    handleRenameShader,
  };
}
