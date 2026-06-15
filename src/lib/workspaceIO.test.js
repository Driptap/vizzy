import { describe, it, expect, vi, beforeEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { makeNodePlatform } from '../test/fakePlatform';

// workspaceIO reaches disk through the platform layer; back it with the real
// fs against a fresh temp userData dir so export/replace run end to end.
let root;
let plat;
let io;
let lib;
let session;

vi.mock('../platform', async () => {
  const types = await vi.importActual('../platform/types');
  return {
    joinPath: types.joinPath,
    extname: types.extname,
    isTauri: () => false,
    getPlatform: () => plat,
  };
});

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vizzy-ws-'));
  plat = makeNodePlatform(root);
  vi.resetModules();
  io = await import('./workspaceIO');
  lib = await import('./shaderLibrary');
  session = await import('./session');
});

const PATCH = { generator: 'plasma', palette: { preset: 'rainbow' } };
const SPEC = { kind: 'terrain', surface: 'sin(x)', amplitude: 2, palette: ['#111111', '#222222', '#333333'] };
const SESSION = {
  version: 1,
  crossfade: 0.5,
  cueScene: 0,
  slots: [{ source: { type: 'shader', patch: PATCH } }],
};

describe('packWorkspace / unpackWorkspace', () => {
  const manifest = {
    format: 'vizzy-workspace',
    version: 1,
    exportedAt: 123,
    library: [{ id: 'shader-1', patch: PATCH, createdAt: 1 }],
    session: SESSION,
  };

  it('round-trips the manifest and asset bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250]);
    const packed = io.packWorkspace(manifest, { 'model-1.stl': bytes });
    const { manifest: out, assets } = io.unpackWorkspace(packed);
    expect(out).toEqual(manifest);
    expect(assets['model-1.stl']).toEqual(bytes);
  });

  it('rejects files that are not Vizzy workspaces', () => {
    expect(() => io.unpackWorkspace(new Uint8Array([0, 1, 2]))).toThrow(/valid \.vizzy/);
  });

  it('rejects a wrong format discriminator', () => {
    const packed = io.packWorkspace({ ...manifest, format: 'something-else' }, {});
    expect(() => io.unpackWorkspace(packed)).toThrow(/not a Vizzy workspace/i);
  });

  it('rejects an unsupported version', () => {
    const packed = io.packWorkspace({ ...manifest, version: 2 }, {});
    expect(() => io.unpackWorkspace(packed)).toThrow(/version 2/);
  });
});

describe('export → replace round-trip', () => {
  // seed a representative workspace: a shader, a scene, a model asset, a session
  const seed = async () => {
    const shader = await lib.saveShader({ name: 'S', patch: PATCH });
    const scene = await lib.saveScene({ name: 'Sc', spec: SPEC });
    const model = await lib.saveAssetFromBuffer({
      kind: 'model',
      name: 'M',
      bytes: new Uint8Array([9, 8, 7, 6]),
      ext: '.stl',
    });
    await session.saveSession(SESSION);
    return { shader, scene, model };
  };

  it('reports progress through reading → packing → writing', async () => {
    await seed(); // 1 asset
    const events = [];
    const file = path.join(root, 'out.vizzy');
    await io.exportWorkspace(file, (p) => events.push({ ...p }));

    const phases = events.map((e) => e.phase);
    expect(phases).toContain('reading');
    expect(phases).toContain('packing');
    expect(phases).toContain('writing');
    // last reading event accounts for every asset
    const lastReading = events.filter((e) => e.phase === 'reading').at(-1);
    expect(lastReading).toEqual({ phase: 'reading', done: 1, total: 1 });
    // phases never go backwards: packing/writing come after the reads complete
    expect(phases.indexOf('packing')).toBeGreaterThan(phases.lastIndexOf('reading') - 1);
    expect(phases.lastIndexOf('writing')).toBe(phases.length - 1);
  });

  it('bundles every entry + the session, and asset bytes travel inside the file', async () => {
    const { model } = await seed();
    const file = path.join(root, 'out.vizzy');
    const result = await io.exportWorkspace(file);
    expect(result).toEqual({ entries: 3, assets: 1 });

    // read the written file back as an opaque blob and unpack it
    const bundle = io.unpackWorkspace(new Uint8Array(await fsp.readFile(file)));
    expect(bundle.manifest.library).toHaveLength(3);
    expect(bundle.manifest.session).toEqual(SESSION);
    // the model's bytes are carried by `file`, so it isn't a dangling reference
    expect(bundle.assets[model.file]).toEqual(new Uint8Array([9, 8, 7, 6]));
  });

  it('replace wipes the current workspace, then writes the bundle back verbatim', async () => {
    const { shader, scene, model } = await seed();
    const file = path.join(root, 'out.vizzy');
    await io.exportWorkspace(file);
    const bundle = io.unpackWorkspace(new Uint8Array(await fsp.readFile(file)));

    // mutate the live workspace so we can prove replace really resets it
    await lib.saveShader({ name: 'stray', patch: PATCH });
    expect(await lib.listShaders()).toHaveLength(4);

    const entries = await io.replaceWorkspace(bundle);

    // exactly the bundle's three entries survive — the stray shader is gone
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual([model.id, scene.id, shader.id].sort());
    expect((await lib.listShaders()).map((e) => e.id).sort()).toEqual(ids);
    // the asset blob is back on disk with its original bytes
    const modelPath = path.join(root, 'models', model.file);
    expect(new Uint8Array(await fsp.readFile(modelPath))).toEqual(new Uint8Array([9, 8, 7, 6]));
    // the session was restored
    expect(await session.loadSession()).toEqual(SESSION);
  });

  it('clears the session when the bundle carried none', async () => {
    await seed();
    const bundle = {
      manifest: { format: 'vizzy-workspace', version: 1, exportedAt: 1, library: [], session: null },
      assets: {},
    };
    await io.replaceWorkspace(bundle);
    expect(await session.loadSession()).toBeNull();
    expect(await lib.listShaders()).toEqual([]);
  });

  it('drops an asset entry whose bytes are missing from the bundle', async () => {
    const bundle = {
      manifest: {
        format: 'vizzy-workspace',
        version: 1,
        exportedAt: 1,
        // references a model file that isn't in assets — must not be listed
        library: [
          { id: 'shader-keep', patch: PATCH, createdAt: 1 },
          { id: 'model-gone', kind: 'model', file: 'model-gone.stl', createdAt: 2 },
        ],
        session: null,
      },
      assets: {},
    };
    const entries = await io.replaceWorkspace(bundle);
    expect(entries.map((e) => e.id)).toEqual(['shader-keep']);
  });
});
