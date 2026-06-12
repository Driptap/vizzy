// First-launch example content: two shaders, a canvas-drawn PNG sprite and a
// procedurally generated STL torus, tied together in an "Example Deck"
// preset. Everything is synthesized at runtime — no binary assets shipped.
import { saveShader, saveDeck, saveAssetFromBuffer, deleteEntry } from './shaderLibrary';
import { defaultChannelConfig, makeDefaultAut } from './channels';
import type { DeckChannelConfig, DeckEntry, LibraryEntry } from '../types';

export const EXAMPLE_DECK_NAME = 'Example Deck';
const EXAMPLE_NAMES = new Set([
  EXAMPLE_DECK_NAME,
  'Example · Plasma Flow',
  'Example · Neon Rings',
  'Example · Neon Star',
  'Example · Torus',
  'Example · Vapor Terrain',
]);

/**
 * Removes duplicate example entries left behind by repeated seeding (the
 * pre-marker-file bug): keeps the newest of each example name — entries
 * arrive newest-first, so the kept set is one self-consistent seed batch —
 * and deletes the rest (including their asset files).
 */
export async function dedupeExampleEntries(entries: LibraryEntry[]): Promise<LibraryEntry[]> {
  const seen = new Set<string>();
  const dupes: LibraryEntry[] = [];
  entries.forEach((entry) => {
    if (!entry.name || !EXAMPLE_NAMES.has(entry.name)) return;
    if (seen.has(entry.name)) dupes.push(entry);
    else seen.add(entry.name);
  });
  if (!dupes.length) return entries;
  console.log(`[Vizzy] Removing ${dupes.length} duplicate example entries`);
  await Promise.all(dupes.map((entry) => deleteEntry(entry).catch(() => {})));
  const dupeIds = new Set(dupes.map((entry) => entry.id));
  return entries.filter((entry) => !dupeIds.has(entry.id));
}

const PLASMA_BODY = `void main() {
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float t = u_time * 0.6;
  float v = sin(p.x * 4.0 + t)
          + sin(p.y * 3.0 - t * 1.3)
          + sin((p.x + p.y) * 5.0 + t * 0.7)
          + sin(length(p) * 8.0 - t * 2.0);
  v = v * 0.25 + 0.5;
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (v + u_time * 0.05 + vec3(0.0, 0.33, 0.67)));
  col *= 0.6 + 0.8 * u_audio_level;
  col += vec3(u_audio_low, u_audio_mid, u_audio_high) * 0.25;
  gl_FragColor = vec4(col, 1.0);
}`;

const RINGS_BODY = `void main() {
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float r = length(p);
  float rings = sin(r * 24.0 - u_time * 3.0 - u_audio_low * 6.0);
  float m = smoothstep(0.2, 0.9, rings);
  vec3 col = mix(vec3(0.02, 0.0, 0.05), vec3(0.1, 0.9, 1.0), m);
  col *= smoothstep(1.1, 0.2, r) * (0.5 + 0.8 * u_audio_level);
  gl_FragColor = vec4(col, 1.0);
}`;

function dataURLToBytes(dataURL: string): Uint8Array {
  const bin = atob(dataURL.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// simple gradient thumbnail with a label, for entries with no natural preview
function gradientThumb(label: string, colorA: string, colorB: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 160, 90);
  grad.addColorStop(0, colorA);
  grad.addColorStop(1, colorB);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 160, 90);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, 80, 50);
  return canvas.toDataURL('image/jpeg', 0.8);
}

// neon ring + star on transparent ground, drawn at 512^2
function makeStarSprite(): { bytes: Uint8Array; thumbnail: string } {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;

  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 14;
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 45;
  for (let pass = 0; pass < 2; pass += 1) {
    ctx.beginPath();
    ctx.arc(c, c, 175, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#e879f9';
  ctx.shadowColor = '#e879f9';
  ctx.shadowBlur = 38;
  const star = new Path2D();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? 120 : 50;
    const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = c + radius * Math.cos(angle);
    const y = c + radius * Math.sin(angle);
    if (i === 0) star.moveTo(x, y);
    else star.lineTo(x, y);
  }
  star.closePath();
  ctx.fill(star);
  ctx.fill(star);

  // thumbnail: same image flattened onto black at library size
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 160;
  thumbCanvas.height = 90;
  const tctx = thumbCanvas.getContext('2d')!;
  tctx.fillStyle = '#000';
  tctx.fillRect(0, 0, 160, 90);
  tctx.drawImage(canvas, 35, 0, 90, 90);

  return {
    bytes: dataURLToBytes(canvas.toDataURL('image/png')),
    thumbnail: thumbCanvas.toDataURL('image/jpeg', 0.8),
  };
}

// binary STL torus — STLLoader recomputes vertex normals on load
function makeTorusSTL(R = 1.0, r = 0.45, segU = 48, segV = 24): Uint8Array {
  const point = (i: number, j: number): [number, number, number] => {
    const u = (i / segU) * Math.PI * 2;
    const v = (j / segV) * Math.PI * 2;
    return [
      Math.cos(u) * (R + r * Math.cos(v)),
      Math.sin(u) * (R + r * Math.cos(v)),
      r * Math.sin(v),
    ];
  };
  const tris: [number, number, number][][] = [];
  for (let i = 0; i < segU; i += 1) {
    for (let j = 0; j < segV; j += 1) {
      const a = point(i, j);
      const b = point(i + 1, j);
      const cc = point(i + 1, j + 1);
      const d = point(i, j + 1);
      tris.push([a, b, cc], [a, cc, d]);
    }
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((tri, k) => {
    let o = 84 + k * 50;
    [[0, 0, 0], ...tri].forEach((vec) => {
      dv.setFloat32(o, vec[0], true);
      dv.setFloat32(o + 4, vec[1], true);
      dv.setFloat32(o + 8, vec[2], true);
      o += 12;
    });
  });
  return new Uint8Array(buf);
}

// Binary STL terrain tile for landscape mode: a sine-ridged heightfield with
// a flat corridor down the middle so the fly-over camera has a canyon to run.
function makeTerrainSTL(W = 48, D = 36, segX = 56, segZ = 42): Uint8Array {
  const height = (x: number, z: number): number => {
    const ridge = Math.abs(
      Math.sin(x * 0.33 + Math.sin(z * 0.21) * 1.4) * Math.cos(z * 0.27 - x * 0.06),
    );
    const rolling = 0.5 + 0.5 * Math.sin(x * 0.11 + z * 0.17);
    const valley = Math.min(1, Math.abs(x) / (W * 0.16)); // flat strip at x=0
    return (ridge * 2.6 + rolling * 1.2) * valley * valley;
  };
  const point = (i: number, j: number): [number, number, number] => {
    const x = (i / segX - 0.5) * W;
    const z = (j / segZ) * D;
    return [x, height(x, z), z];
  };
  const tris: [number, number, number][][] = [];
  for (let i = 0; i < segX; i += 1) {
    for (let j = 0; j < segZ; j += 1) {
      const a = point(i, j);
      const b = point(i + 1, j);
      const c = point(i + 1, j + 1);
      const d = point(i, j + 1);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((tri, k) => {
    let o = 84 + k * 50;
    [[0, 0, 0] as [number, number, number], ...tri].forEach((vec) => {
      dv.setFloat32(o, vec[0], true);
      dv.setFloat32(o + 4, vec[1], true);
      dv.setFloat32(o + 8, vec[2], true);
      o += 12;
    });
  });
  return new Uint8Array(buf);
}

/** Creates the example entries + deck preset; returns them newest-first. */
export async function seedExampleLibrary(): Promise<{ deck: DeckEntry; entries: LibraryEntry[] }> {
  const plasma = await saveShader({
    name: 'Example · Plasma Flow',
    code: PLASMA_BODY,
    screenshot: gradientThumb('PLASMA', '#0ea5e9', '#d946ef'),
  });
  const rings = await saveShader({
    name: 'Example · Neon Rings',
    code: RINGS_BODY,
    screenshot: gradientThumb('RINGS', '#0f172a', '#06b6d4'),
  });
  const starAsset = makeStarSprite();
  const sprite = await saveAssetFromBuffer({
    kind: 'sprite',
    name: 'Example · Neon Star',
    bytes: starAsset.bytes,
    ext: '.png',
    screenshot: starAsset.thumbnail,
  });
  const torus = await saveAssetFromBuffer({
    kind: 'model',
    name: 'Example · Torus',
    bytes: makeTorusSTL(),
    ext: '.stl',
    screenshot: gradientThumb('TORUS', '#0f172a', '#10b981'),
  });
  // right-click -> "Landscape on ..." stages this as fly-over terrain
  const terrain = await saveAssetFromBuffer({
    kind: 'model',
    name: 'Example · Vapor Terrain',
    bytes: makeTerrainSTL(),
    ext: '.stl',
    screenshot: gradientThumb('TERRAIN', '#2e1065', '#db2777'),
  });

  const channels: DeckChannelConfig[] = [
    {
      ...defaultChannelConfig(),
      shaderId: plasma.id,
      opacity: 1,
      prompt: 'flowing plasma waves reacting to the bass',
    },
    {
      ...defaultChannelConfig(),
      spriteId: sprite.id,
      opacity: 0.85,
      size: { x: 0.7, y: 0.7 },
      aut: { ...makeDefaultAut(), scl: { amt: 0.55, audio: true }, rot: { amt: 0.12, audio: false } },
    },
    {
      ...defaultChannelConfig(),
      modelId: torus.id,
      opacity: 0.9,
      aut: { ...makeDefaultAut(), rot: { amt: 0.35, audio: false }, dst: { amt: 0.3, audio: true } },
    },
    {
      ...defaultChannelConfig(),
      shaderId: rings.id,
      prompt: 'pulsing concentric neon rings',
    },
  ];
  const deck = await saveDeck({
    name: 'Example Deck',
    channels,
    screenshot: gradientThumb('EXAMPLE DECK', '#155e75', '#701a75'),
  });

  return { deck, entries: [deck, terrain, torus, sprite, rings, plasma] };
}
