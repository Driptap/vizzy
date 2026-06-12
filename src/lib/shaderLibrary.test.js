import { describe, it, expect, vi, beforeEach } from 'vitest';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeNodePlatform } from '../test/fakePlatform';

// The library reaches the host through the platform layer; back it with the
// real fs against a fresh temp userData dir per test, so these tests
// exercise the actual read/write/copy logic end to end.
let root;
let lib;
let plat;

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
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vizzy-lib-'));
  plat = makeNodePlatform(root);
  vi.resetModules();
  lib = await import('./shaderLibrary');
});

const shaderFiles = () => fsSync.readdirSync(path.join(root, 'shaders'));

describe('shader entries', () => {
  const patch = { generator: 'plasma', palette: { preset: 'rainbow' } };

  it('saveShader persists an entry listShaders can read back', async () => {
    const saved = await lib.saveShader({ name: 'Test', patch, screenshot: 'data:thumb' });
    expect(saved.id).toMatch(/^shader-/);

    const entries = await lib.listShaders();
    expect(entries).toEqual([saved]);
  });

  it('listShaders returns entries newest-first', async () => {
    await lib.updateEntry({ id: 'old', name: 'old', patch, createdAt: 100 });
    await lib.updateEntry({ id: 'new', name: 'new', patch, createdAt: 300 });
    await lib.updateEntry({ id: 'mid', name: 'mid', patch, createdAt: 200 });
    expect((await lib.listShaders()).map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('listShaders skips unreadable files and non-JSON files', async () => {
    const saved = await lib.saveShader({ patch });
    await fsp.writeFile(path.join(root, 'shaders', 'broken.json'), '{nope');
    await fsp.writeFile(path.join(root, 'shaders', 'notes.txt'), 'not an entry');
    expect(await lib.listShaders()).toEqual([saved]);
  });

  it('listShaders drops pre-patch GLSL entries', async () => {
    await lib.updateEntry({ id: 'legacy', code: 'void main() {}', createdAt: 999 });
    const saved = await lib.saveShader({ patch });
    expect(await lib.listShaders()).toEqual([saved]);
  });

  it('renameShader rewrites the entry in place', async () => {
    const saved = await lib.saveShader({ patch });
    const renamed = await lib.renameShader(saved, 'My Shader');
    expect(renamed).toEqual({ ...saved, name: 'My Shader' });
    expect(await lib.listShaders()).toEqual([renamed]);
    expect(shaderFiles()).toHaveLength(1);
  });

  it('deleteEntry removes the entry file and tolerates repeats', async () => {
    const saved = await lib.saveShader({ patch });
    await lib.deleteEntry(saved);
    expect(await lib.listShaders()).toEqual([]);
    await expect(lib.deleteEntry(saved)).resolves.toBeUndefined();
  });
});

describe('deck entries', () => {
  it('saveDeck stores kind deck with channels', async () => {
    const channels = [{ shaderId: 'shader-1', opacity: 1 }];
    const deck = await lib.saveDeck({ name: 'Set', channels });
    expect(deck.id).toMatch(/^deck-/);
    expect(deck.kind).toBe('deck');
    expect((await lib.listShaders())[0].channels).toEqual(channels);
  });
});

describe('asset entries', () => {
  it('saveModel copies the source file into the library', async () => {
    const source = path.join(root, 'imported.glb');
    await fsp.writeFile(source, 'GLB-BYTES');

    const entry = await lib.saveModel({ sourcePath: source, name: 'Torus' });
    expect(entry.kind).toBe('model');
    expect(entry.file).toMatch(/^model-.*\.glb$/);

    const copied = await lib.getModelFilePath(entry);
    expect(await fsp.readFile(copied, 'utf8')).toBe('GLB-BYTES');
  });

  it('saveSprite copies the image and keeps the thumbnail', async () => {
    const source = path.join(root, 'star.PNG');
    await fsp.writeFile(source, 'PNG-BYTES');

    const entry = await lib.saveSprite({ sourcePath: source, name: 'Star', screenshot: 'thumb' });
    expect(entry.kind).toBe('sprite');
    expect(entry.file).toMatch(/\.png$/); // extension lowercased
    expect(entry.screenshot).toBe('thumb');
    expect(await fsp.readFile(await lib.getSpriteFilePath(entry), 'utf8')).toBe('PNG-BYTES');
  });

  it('saveAssetFromBuffer writes in-memory bytes for both kinds', async () => {
    const model = await lib.saveAssetFromBuffer({
      kind: 'model',
      name: 'Seeded',
      bytes: Buffer.from('STL'),
      ext: '.stl',
    });
    expect(await fsp.readFile(await lib.getModelFilePath(model), 'utf8')).toBe('STL');

    const sprite = await lib.saveAssetFromBuffer({
      kind: 'sprite',
      name: 'Seeded',
      bytes: Buffer.from('IMG'),
      ext: '.png',
    });
    expect(await fsp.readFile(await lib.getSpriteFilePath(sprite), 'utf8')).toBe('IMG');
  });

  it('deleteEntry also removes the copied asset file', async () => {
    const source = path.join(root, 'imported.glb');
    await fsp.writeFile(source, 'GLB');
    const entry = await lib.saveModel({ sourcePath: source });
    const assetPath = await lib.getModelFilePath(entry);

    await lib.deleteEntry(entry);
    expect(fsSync.existsSync(assetPath)).toBe(false);
    expect(await lib.listShaders()).toEqual([]);
  });
});

describe('seeded marker', () => {
  it('is absent until written', async () => {
    expect(await lib.hasSeededMarker()).toBe(false);
    await lib.writeSeededMarker();
    expect(await lib.hasSeededMarker()).toBe(true);
    expect(fsSync.existsSync(path.join(root, '.vizzy-seeded'))).toBe(true);
  });
});
