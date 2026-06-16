// Bumps the app version across the three files that must stay in lockstep:
// package.json, src-tauri/tauri.conf.json (the version the updater compares),
// and src-tauri/Cargo.toml. The updater only ships a build whose version is
// strictly greater than what's installed — see memory/autoupdate-setup.md.
//
//   npm run bump            # patch: 0.1.0 -> 0.1.1
//   npm run bump -- minor   # 0.1.0 -> 0.2.0
//   npm run bump -- major   # 0.1.0 -> 1.0.0
//   npm run bump -- 0.4.2   # explicit version
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function nextVersion(current, arg) {
  if (SEMVER.test(arg)) return arg;
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`Current version "${current}" is not plain semver`);
  let [major, minor, patch] = m.slice(1).map(Number);
  if (arg === 'major') [major, minor, patch] = [major + 1, 0, 0];
  else if (arg === 'minor') [minor, patch] = [minor + 1, 0];
  else if (arg === 'patch') patch += 1;
  else throw new Error(`Unknown bump "${arg}" — use major | minor | patch | X.Y.Z`);
  return `${major}.${minor}.${patch}`;
}

const arg = process.argv[2] ?? 'patch';
const current = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
const next = nextVersion(current, arg);

// Targeted line edits rather than JSON re-serialization, so the files keep
// their hand-authored formatting (compact arrays in tauri.conf.json etc.).
// package.json + tauri.conf.json: the only top-level `"version": "X"`.
for (const path of [pkgPath, confPath]) {
  const text = readFileSync(path, 'utf8');
  const bumped = text.replace(/"version": "[^"]*"/, `"version": "${next}"`);
  if (bumped === text) throw new Error(`Could not find a version field in ${path}`);
  writeFileSync(path, bumped);
}

// Cargo.toml: the [package] version line (deps use inline `{ version = ... }`,
// which never starts a line, so the anchor is safe).
const cargo = readFileSync(cargoPath, 'utf8');
const bumped = cargo.replace(/^version = "[^"]*"/m, `version = "${next}"`);
if (bumped === cargo) throw new Error('Could not find the [package] version line in Cargo.toml');
writeFileSync(cargoPath, bumped);

console.log(`Bumped ${current} -> ${next}`);
console.log('Updated: package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml');
console.log('Push to main to publish the update.');
