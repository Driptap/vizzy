import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./modelLoader', () => ({
  loadModelObject: vi.fn(async () => ({ kind: 'object3d' })),
}));
vi.mock('./spriteLoader', () => ({
  loadSpriteTexture: vi.fn(async () => ({ texture: { id: 'tex' }, aspect: 1.5 })),
}));
vi.mock('./shaderLibrary', () => ({
  getModelFilePath: vi.fn(async (entry) => `/models/${entry.file}`),
  getSpriteFilePath: vi.fn(async (entry) => `/sprites/${entry.file}`),
}));

import { stageSource, resolveSourceRef } from './sourceStaging';
import { loadModelObject } from './modelLoader';

const sceneSpec = {
  kind: 'tunnel',
  surface: 'sin(a * 4) + fract(z * 0.5)',
  amplitude: 2,
  palette: ['#1a0533', '#05ffa1', '#000000'],
};
const sceneEntry = { id: 'scene-1', kind: 'scene', spec: sceneSpec, createdAt: 4 };

const makeEngine = () => ({
  stageShader: vi.fn(() => ({ ok: true })),
  stageSprite: vi.fn(() => ({ ok: true })),
  stageModel: vi.fn(async () => ({ ok: true })),
  stageLandscape: vi.fn(async () => ({ ok: true })),
  stageScene: vi.fn(async () => ({ ok: true })),
});

const modelEntry = { id: 'model-1', kind: 'model', file: 'm.stl', createdAt: 1 };
const spriteEntry = { id: 'sprite-1', kind: 'sprite', file: 's.png', createdAt: 2 };
const shaderEntry = { id: 'shader-1', code: 'void main() {}', createdAt: 3 };

beforeEach(() => vi.clearAllMocks());

describe('stageSource', () => {
  it('stages shaders synchronously through the engine', async () => {
    const engine = makeEngine();
    const result = await stageSource(engine, 2, { type: 'shader', code: 'void main() {}' });
    expect(result).toEqual({ ok: true });
    expect(engine.stageShader).toHaveBeenCalledWith(2, 'void main() {}');
  });

  it('loads and stages models', async () => {
    const engine = makeEngine();
    await stageSource(engine, 1, { type: 'model', entry: modelEntry });
    expect(loadModelObject).toHaveBeenCalledWith('/models/m.stl');
    expect(engine.stageModel).toHaveBeenCalledWith(1, { kind: 'object3d' }, 'model-1');
    expect(engine.stageLandscape).not.toHaveBeenCalled();
  });

  it('stages the same model entry as a landscape when asked', async () => {
    const engine = makeEngine();
    await stageSource(engine, 3, { type: 'landscape', entry: modelEntry });
    expect(engine.stageLandscape).toHaveBeenCalledWith(3, { kind: 'object3d' }, 'model-1');
    expect(engine.stageModel).not.toHaveBeenCalled();
  });

  it('builds and stages procedural scenes from their spec', async () => {
    const engine = makeEngine();
    const result = await stageSource(engine, 2, { type: 'scene', spec: sceneSpec });
    expect(result).toEqual({ ok: true });
    const [slot, object, spec] = engine.stageScene.mock.calls[0];
    expect(slot).toBe(2);
    expect(object.children).toHaveLength(1); // a real built Group
    expect(spec).toBe(sceneSpec);
  });

  it('an uncompilable scene spec fails cleanly instead of throwing', async () => {
    const engine = makeEngine();
    const result = await stageSource(engine, 0, {
      type: 'scene',
      spec: { ...sceneSpec, surface: 'nonsense(z)' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown function/);
    expect(engine.stageScene).not.toHaveBeenCalled();
  });

  it('loads and stages sprites with their aspect', async () => {
    const engine = makeEngine();
    await stageSource(engine, 0, { type: 'sprite', entry: spriteEntry });
    expect(engine.stageSprite).toHaveBeenCalledWith(0, { id: 'tex' }, 1.5, 'sprite-1');
  });

  it('returns a failure instead of throwing when a loader dies', async () => {
    loadModelObject.mockRejectedValueOnce(new Error('corrupt file'));
    const engine = makeEngine();
    const result = await stageSource(engine, 0, { type: 'landscape', entry: modelEntry });
    expect(result).toEqual({ ok: false, error: 'corrupt file' });
  });

  it('maps a failed shader compile to an error result', async () => {
    const engine = makeEngine();
    engine.stageShader.mockReturnValueOnce({ ok: false, error: 'bad GLSL' });
    const result = await stageSource(engine, 0, { type: 'shader', code: 'nope' });
    expect(result).toEqual({ ok: false, error: 'bad GLSL' });
  });
});

describe('resolveSourceRef', () => {
  const byId = new Map(
    [modelEntry, spriteEntry, shaderEntry, sceneEntry].map((e) => [e.id, e]),
  );

  it('resolves deck-preset refs by id kind', () => {
    expect(resolveSourceRef({ shaderId: 'shader-1' }, byId).source).toEqual({
      type: 'shader',
      code: shaderEntry.code,
    });
    expect(resolveSourceRef({ modelId: 'model-1' }, byId).source).toEqual({
      type: 'model',
      entry: modelEntry,
    });
    expect(resolveSourceRef({ spriteId: 'sprite-1' }, byId).source).toEqual({
      type: 'sprite',
      entry: spriteEntry,
    });
    expect(resolveSourceRef({ landscapeId: 'model-1' }, byId).source).toEqual({
      type: 'landscape',
      entry: modelEntry,
    });
  });

  it('resolves scene refs: deck presets by sceneId, sessions by inline spec', () => {
    expect(resolveSourceRef({ sceneId: 'scene-1' }, byId).source).toEqual({
      type: 'scene',
      spec: sceneSpec,
    });
    expect(resolveSourceRef({ type: 'scene', spec: sceneSpec }, byId).source).toEqual({
      type: 'scene',
      spec: sceneSpec,
    });
    expect(resolveSourceRef({ sceneId: 'gone' }, byId).error).toBe(
      'Saved scene is missing from the library',
    );
  });

  it('resolves session sources, keeping landscape distinct from model', () => {
    // a session landscape source carries BOTH type and modelId — it must not
    // fall into the plain-model branch and restore as a spinning object
    expect(resolveSourceRef({ type: 'landscape', modelId: 'model-1' }, byId).source).toEqual({
      type: 'landscape',
      entry: modelEntry,
    });
    expect(resolveSourceRef({ type: 'model', modelId: 'model-1' }, byId).source).toEqual({
      type: 'model',
      entry: modelEntry,
    });
    expect(resolveSourceRef({ type: 'shader', code: 'void main() {}' }, byId).source).toEqual({
      type: 'shader',
      code: 'void main() {}',
    });
  });

  it('reports missing entries per kind', () => {
    expect(resolveSourceRef({ modelId: 'gone' }, byId).error).toBe(
      'Saved model is missing from the library',
    );
    expect(resolveSourceRef({ landscapeId: 'gone' }, byId).error).toBe(
      'Saved landscape is missing from the library',
    );
    expect(resolveSourceRef({ spriteId: 'gone' }, byId).error).toBe(
      'Saved sprite is missing from the library',
    );
    expect(resolveSourceRef({ shaderId: 'gone' }, byId).error).toBe(
      'Saved shader is missing from the library',
    );
  });

  it('reports an empty ref as nothing to stage', () => {
    expect(resolveSourceRef({}, byId).error).toBe('Nothing to stage');
    expect(resolveSourceRef({ type: 'shader', code: null }, byId).error).toBe('Nothing to stage');
  });
});
