// Node-fs-backed Platform for tests: same shape as src/platform, rooted at a
// temp dir, so persistence tests exercise the real read/write/copy logic.
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export function makeNodePlatform(root) {
  const ensured = (name) => async () => {
    const dir = path.join(root, name);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  };
  return {
    kind: 'browser',
    dirs: {
      userData: async () => root,
      shaders: ensured('shaders'),
      models: ensured('models'),
      sprites: ensured('sprites'),
      videos: ensured('videos'),
    },
    fs: {
      readText: (p) => fsp.readFile(p, 'utf8'),
      writeText: (p, data) => fsp.writeFile(p, data),
      readBytes: async (p) => new Uint8Array(await fsp.readFile(p)),
      writeBytes: (p, data) => fsp.writeFile(p, data),
      readDir: (p) => fsp.readdir(p),
      remove: (p) => fsp.unlink(p).catch(() => {}),
      copy: (src, dest) => fsp.copyFile(src, dest),
      exists: (p) =>
        fsp.access(p).then(
          () => true,
          () => false,
        ),
      mkdir: (p) => fsp.mkdir(p, { recursive: true }).then(() => {}),
    },
    writeTextLastGasp: (p, data) => {
      try {
        fsSync.writeFileSync(p, data);
      } catch {
        // best-effort by contract
      }
    },
    pickFiles: async () => null,
    saveFileDialog: async () => null,
    onFileDrop: () => () => {},
    ollama: {
      status: async () => ({ installed: false, running: false, managedPort: 11435, platform: 'test' }),
      install: async () => {},
      start: async () => false,
    },
  };
}
