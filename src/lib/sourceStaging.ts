// One staging path for everything that can land on a deck slot, used by
// library assignment, deck-preset loading and session restore alike.
import { loadModelObject } from './modelLoader';
import { loadSpriteTexture } from './spriteLoader';
import { getModelFilePath, getSpriteFilePath } from './shaderLibrary';
import type { RenderEngine } from '../engine/RenderEngine';
import type {
  ChannelSource,
  DeckChannelConfig,
  LibraryEntry,
  ModelEntry,
  SpriteEntry,
  StageResult,
  StageableSource,
} from '../types';

/** Stage a resolved source onto an engine slot. Never throws. */
export async function stageSource(
  engine: RenderEngine,
  slot: number,
  source: StageableSource,
): Promise<StageResult> {
  try {
    if (source.type === 'model') {
      const object = await loadModelObject(await getModelFilePath(source.entry));
      await engine.stageModel(slot, object, source.entry.id);
      return { ok: true };
    }
    if (source.type === 'sprite') {
      const { texture, aspect } = await loadSpriteTexture(await getSpriteFilePath(source.entry));
      engine.stageSprite(slot, texture, aspect, source.entry.id);
      return { ok: true };
    }
    const result = engine.stageShader(slot, source.code);
    return result?.ok ? { ok: true } : { ok: false, error: result?.error || 'Compile failed' };
  } catch (err) {
    console.error(`[Vizzy] Staging ${source.type} failed:`, err);
    const fallback = source.type === 'model' ? 'Model load failed' : 'Image load failed';
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
  const anyRef = ref as { modelId?: string; spriteId?: string; shaderId?: string; type?: string; code?: string | null };
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
    return entry && 'code' in entry && entry.code
      ? { source: { type: 'shader', code: entry.code } }
      : { error: 'Saved shader is missing from the library' };
  }
  if (anyRef.type === 'shader' && anyRef.code) {
    return { source: { type: 'shader', code: anyRef.code } };
  }
  return { error: 'Nothing to stage' };
}
