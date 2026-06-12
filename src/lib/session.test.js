import { describe, it, expect, vi, beforeEach } from 'vitest';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeNodePlatform } from '../test/fakePlatform';

// session.ts reaches the host through the platform layer; back it with the
// real fs against a fresh temp dir, then import the module under test fresh
// each time so its memoized session path resets.
let userDataDir;
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

async function importSession() {
  userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vizzy-session-'));
  plat = makeNodePlatform(userDataDir);
  vi.resetModules();
  return import('./session');
}

beforeEach(() => {
  vi.resetModules();
});

describe('session persistence', () => {
  it('round-trips the session through disk', async () => {
    const session = await importSession();
    const data = { version: 1, crossfade: 0.5, slots: [{ prompt: 'hi' }] };
    await session.saveSession(data);
    expect(await session.loadSession()).toEqual(data);
    expect(fsSync.existsSync(path.join(userDataDir, 'session.json'))).toBe(true);
  });

  it('loadSession returns null when no session exists', async () => {
    const session = await importSession();
    expect(await session.loadSession()).toBeNull();
  });

  it('loadSession returns null for a corrupt file', async () => {
    const session = await importSession();
    await fsp.writeFile(path.join(userDataDir, 'session.json'), '{nope');
    expect(await session.loadSession()).toBeNull();
  });

  it('saveSessionSync is a no-op before the path resolves, writes after', async () => {
    const session = await importSession();

    session.saveSessionSync({ early: true }); // path not resolved yet
    expect(fsSync.existsSync(path.join(userDataDir, 'session.json'))).toBe(false);

    await session.saveSession({ async: true }); // resolves the path
    session.saveSessionSync({ flushed: true });
    expect(await session.loadSession()).toEqual({ flushed: true });
  });

  it('saveSessionSync swallows write errors', async () => {
    const session = await importSession();
    await session.saveSession({ a: 1 });
    const spy = vi.spyOn(fsSync, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => session.saveSessionSync({ b: 2 })).not.toThrow();
    spy.mockRestore();
  });
});
