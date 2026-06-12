import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./shaderLibrary', () => ({
  getModelFilePath: vi.fn(async (entry) => `/models/${entry.file}`),
  getSpriteFilePath: vi.fn(async (entry) => `/sprites/${entry.file}`),
}));

import { stageSource, resolveSourceRef } from './sourceStaging';

const sceneSpec = {
  kind: 'tunnel',
  surface: 'sin(a * 4) + fract(z * 0.5)',
  amplitude: 2,
  palette: ['#1a0533', '#05ffa1', '#000000'],
};
const sceneEntry = { id: 'scene-1', kind: 'scene', spec: sceneSpec, createdAt: 4 };

// the engine is the NativeRenderEngine surface stageSource drives
const makeEngine = () => ({
  stageShader: vi.fn(async () => ({ ok: true })),
  stageSpriteFromPath: vi.fn(async () => ({ ok: true })),
  stageModelFromPath: vi.fn(async () => ({ ok: true })),
  stageLandscapeFromPath: vi.fn(async () => ({ ok: true })),
  stageSceneSpec: vi.fn(async () => ({ ok: true })),
});

const modelEntry = { id: 'model-1', kind: 'model', file: 'm.stl', createdAt: 1 };
const spriteEntry = { id: 'sprite-1', kind: 'sprite', file: 's.png', createdAt: 2 };
const shaderEntry = { id: 'shader-1', code: 'void main() {}', createdAt: 3 };

beforeEach(() => vi.clearAllMocks());

describe('stageSource', () => {
  it('stages shaders through the engine', async () => {
    const engine = makeEngine();
    const result = await stageSource(engine, 2, { type: 'shader', code: 'void main() {}' });
    expect(result).toEqual({ ok: true });
    expect(engine.stageShader).toHaveBeenCalledWith(2, 'void main() {}');
  });

  it('stages models by library file path', async () => {
    const engine = makeEngine();
    await stageSource(engine, 1, { type: 'model', entry: modelEntry });
    expect(engine.stageModelFromPath).toHaveBeenCalledWith(1, '/models/m.stl', 'model-1');
    expect(engine.stageLandscapeFromPath).not.toHaveBeenCalled();
  });

  it('stages the same model entry as a landscape when asked', async () => {
    const engine = makeEngine();
    await stageSource(engine, 3, { type: 'landscape', entry: modelEntry });
    expect(engine.stageLandscapeFromPath).toHaveBeenCalledWith(3, '/models/m.stl', 'model-1');
    expect(engine.stageModelFromPath).not.toHaveBeenCalled();
  });

  it('stages procedural scenes from their spec', async () => {
    const engine = makeEngine();
    const result = await stageSource(engine, 2, { type: 'scene', spec: sceneSpec });
    expect(result).toEqual({ ok: true });
    expect(engine.stageSceneSpec).toHaveBeenCalledWith(2, sceneSpec);
  });

  it('propagates a failed scene stage as an error result', async () => {
    const engine = makeEngine();
    engine.stageSceneSpec.mockResolvedValueOnce({ ok: false, error: 'Unknown function nonsense' });
    const result = await stageSource(engine, 0, { type: 'scene', spec: sceneSpec });
    expect(result).toEqual({ ok: false, error: 'Unknown function nonsense' });
  });

  it('stages sprites by library file path', async () => {
    const engine = makeEngine();
    await stageSource(engine, 0, { type: 'sprite', entry: spriteEntry });
    expect(engine.stageSpriteFromPath).toHaveBeenCalledWith(0, '/sprites/s.png', 'sprite-1');
  });

  it('returns a failure instead of throwing when staging dies', async () => {
    const engine = makeEngine();
    engine.stageLandscapeFromPath.mockRejectedValueOnce(new Error('corrupt file'));
    const result = await stageSource(engine, 0, { type: 'landscape', entry: modelEntry });
    expect(result).toEqual({ ok: false, error: 'corrupt file' });
  });

  it('maps a failed shader compile to an error result', async () => {
    const engine = makeEngine();
    engine.stageShader.mockResolvedValueOnce({ ok: false, error: 'bad GLSL' });
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
