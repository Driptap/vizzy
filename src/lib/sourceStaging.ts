// One staging path for everything that can land on a deck slot, used by
// library assignment, deck-preset loading and session restore alike. The
// native core loads asset files itself — it gets paths, not parsed objects.
import { getModelFilePath, getSpriteFilePath } from './shaderLibrary';
import type { NativeRenderEngine } from '../engine/NativeRenderEngine';
import type {
  ChannelSource,
  DeckChannelConfig,
  LibraryEntry,
  ModelEntry,
  PatchSpec,
  SceneEntry,
  SceneSpec,
  SpriteEntry,
  StageResult,
  StageableSource,
} from '../types';

const failed = (result: StageResult | undefined): StageResult =>
  result?.ok ? { ok: true } : { ok: false, error: result?.error || 'Content load failed' };

/** Stage a resolved source onto an engine slot. Never throws. */
export async function stageSource(
  engine: NativeRenderEngine,
  slot: number,
  source: StageableSource,
): Promise<StageResult> {
  try {
    if (source.type === 'model') {
      return failed(
        await engine.stageModelFromPath(slot, await getModelFilePath(source.entry), source.entry.id),
      );
    }
    if (source.type === 'landscape') {
      return failed(
        await engine.stageLandscapeFromPath(slot, await getModelFilePath(source.entry), source.entry.id),
      );
    }
    if (source.type === 'sprite') {
      return failed(
        await engine.stageSpriteFromPath(slot, await getSpriteFilePath(source.entry), source.entry.id),
      );
    }
    if (source.type === 'scene') {
      return failed(await engine.stageSceneSpec(slot, source.spec));
    }
    return failed(await engine.stagePatch(slot, source.patch));
  } catch (err) {
    console.error(`[Vizzy] Staging ${source.type} failed:`, err);
    const fallback = source.type === 'sprite' ? 'Image load failed' : 'Content load failed';
    return { ok: false, error: (err as Error).message || fallback };
  }
}

type ResolveResult = { source: StageableSource; error?: undefined } | { source?: undefined; error: string };

/**
 * Resolve a persisted channel reference ({shaderId|modelId|spriteId} from a
 * deck preset, or a session snapshot's {type, code|modelId|spriteId}) into a
 * stageable source, or an error when the referenced entry is gone.
 */
export function resolveSourceRef(
  ref: DeckChannelConfig | ChannelSource | Record<string, never>,
  byId: Map<string, LibraryEntry>,
): ResolveResult {
  const anyRef = ref as {
    modelId?: string;
    spriteId?: string;
    shaderId?: string;
    landscapeId?: string;
    sceneId?: string;
    type?: string;
    patch?: PatchSpec;
    spec?: SceneSpec;
  };
  // procedural scenes: session sources carry the spec inline, deck presets
  // reference a library scene entry by id
  if (anyRef.type === 'scene' && anyRef.spec) {
    return { source: { type: 'scene', spec: anyRef.spec } };
  }
  if (anyRef.sceneId) {
    const entry = byId.get(anyRef.sceneId);
    return entry && entry.kind === 'scene'
      ? { source: { type: 'scene', spec: (entry as SceneEntry).spec } }
      : { error: 'Saved scene is missing from the library' };
  }
  // landscape refs reuse model entries: deck presets carry landscapeId, session
  // sources carry {type: 'landscape', modelId} — both must resolve BEFORE the
  // plain-model checks or a landscape would restore as a spinning model.
  const landscapeModelId =
    anyRef.landscapeId ?? (anyRef.type === 'landscape' ? anyRef.modelId : undefined);
  if (landscapeModelId) {
    const entry = byId.get(landscapeModelId);
    return entry
      ? { source: { type: 'landscape', entry: entry as ModelEntry } }
      : { error: 'Saved landscape is missing from the library' };
  }
  if (anyRef.modelId) {
    const entry = byId.get(anyRef.modelId);
    return entry
      ? { source: { type: 'model', entry: entry as ModelEntry } }
      : { error: 'Saved model is missing from the library' };
  }
  if (anyRef.spriteId) {
    const entry = byId.get(anyRef.spriteId);
    return entry
      ? { source: { type: 'sprite', entry: entry as SpriteEntry } }
      : { error: 'Saved sprite is missing from the library' };
  }
  if (anyRef.shaderId) {
    const entry = byId.get(anyRef.shaderId);
    return entry && 'patch' in entry && entry.patch
      ? { source: { type: 'shader', patch: entry.patch } }
      : { error: 'Saved patch is missing from the library' };
  }
  if (anyRef.type === 'shader' && anyRef.patch) {
    return { source: { type: 'shader', patch: anyRef.patch } };
  }
  return { error: 'Nothing to stage' };
}
