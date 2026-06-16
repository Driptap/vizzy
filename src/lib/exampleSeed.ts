// First-launch example content: a generous starter library of shader patches,
// canvas-drawn sprites, procedural fly-through scenes and STL models, tied
// together by ten "Example · …" deck presets that each show off a different
// feature (layering, per-channel filters, automation, beat loops, landscape
// mode, 3D lighting, …). Everything is synthesized at runtime — no binary
// assets are shipped with the app.
import { saveShader, saveScene, saveDeck, saveAssetFromBuffer, deleteEntry } from './shaderLibrary';
import {
  defaultChannelConfig,
  makeDefaultAut,
  DEFAULT_FX,
  DEFAULT_FILTER,
  DEFAULT_LIGHT,
} from './channels';
import type {
  AutomationMap,
  DeckChannelConfig,
  DeckEntry,
  DeckLoop,
  LibraryEntry,
  LoopPoint,
  PatchSpec,
  SceneSpec,
} from '../types';

// every seeded entry is prefixed so it groups in the library and the dedupe
// pass can recognise its own output
const EX = (name: string) => `Example · ${name}`;
/** the deck assigned to scene 0 on first launch / the seed sentinel */
export const EXAMPLE_DECK_NAME = EX('Welcome');

// ---------------------------------------------------------------------------
// Shader patches — structured PatchSpecs the Rust composer renders directly.
// ---------------------------------------------------------------------------
interface ShaderSeed {
  name: string;
  patch: PatchSpec;
  thumb: [string, string];
}

const SHADERS: ShaderSeed[] = [
  {
    name: 'Plasma Flow',
    patch: {
      generator: 'plasma',
      params: { freq: 4 },
      palette: { preset: 'rainbow' },
      motion: { speed: 0.8 },
      audio: [
        { band: 'level', target: 'brightness', amount: 0.8 },
        { band: 'low', target: 'scale', amount: 0.4 },
      ],
    },
    thumb: ['#0ea5e9', '#d946ef'],
  },
  {
    name: 'Neon Rings',
    patch: {
      generator: 'interference',
      params: { sources: 2, freq: 24 },
      palette: { preset: 'ice' },
      audio: [
        { band: 'low', target: 'speed', amount: 0.8 },
        { band: 'level', target: 'brightness', amount: 0.6 },
      ],
      post: { vignette: 0.4 },
    },
    thumb: ['#0f172a', '#06b6d4'],
  },
  {
    name: 'Synthwave Sun',
    patch: {
      generator: 'synthwave-grid',
      params: { gridScale: 10, sun: 1 },
      palette: { preset: 'synthwave' },
      audio: [{ band: 'low', target: 'scale', amount: 0.4 }],
      post: { vignette: 0.35, scanlines: 0.2 },
    },
    thumb: ['#3b0764', '#f472b6'],
  },
  {
    name: 'Hyperspace',
    patch: {
      generator: 'starfield',
      params: { layers: 4, density: 1.6 },
      palette: { preset: 'ice' },
      warps: [{ type: 'zoomPulse', amount: 0.6, audio: 'beat' }],
      audio: [
        { band: 'high', target: 'brightness', amount: 0.7 },
        { band: 'low', target: 'speed', amount: 0.6 },
      ],
    },
    thumb: ['#020617', '#38bdf8'],
  },
  {
    name: 'Acid Lava',
    patch: {
      generator: 'metaballs',
      params: { blobs: 7, size: 1.2 },
      palette: { preset: 'acid' },
      warps: [{ type: 'swirl', amount: 0.6 }],
      audio: [{ band: 'low', target: 'scale', amount: 0.5 }],
      post: { trail: 0.82, feedZoom: 1.01 },
    },
    thumb: ['#1a2e05', '#bef264'],
  },
  {
    name: 'Pool Caustics',
    patch: {
      generator: 'caustics',
      params: { scale: 7 },
      palette: { preset: 'vapor' },
      warps: [{ type: 'ripple', amount: 0.5, audio: 'mid' }],
      audio: [{ band: 'level', target: 'brightness', amount: 0.6 }],
    },
    thumb: ['#042f2e', '#5eead4'],
  },
  {
    name: 'Temple Mandala',
    patch: {
      generator: 'kaleido-mandala',
      params: { petals: 10, rings: 7 },
      palette: { preset: 'lasergrid' },
      warps: [{ type: 'kaleido', amount: 8 }],
      audio: [
        { band: 'low', target: 'scale', amount: 0.45 },
        { band: 'beat', target: 'brightness', amount: 0.6 },
      ],
    },
    thumb: ['#1e1b4b', '#22d3ee'],
  },
  {
    name: 'Stained Glass',
    patch: {
      generator: 'voronoi',
      params: { cells: 10 },
      palette: { preset: 'miami' },
      audio: [{ band: 'mid', target: 'brightness', amount: 0.6 }],
    },
    thumb: ['#4a044e', '#f0abfc'],
  },
  {
    name: 'Matrix Rain',
    patch: {
      generator: 'matrix-rain',
      params: { columns: 42 },
      palette: { preset: 'matrix' },
      post: { scanlines: 0.4, grain: 0.2 },
    },
    thumb: ['#022c22', '#4ade80'],
  },
  {
    name: 'VHS Signal',
    patch: {
      generator: 'vhs',
      params: { noise: 0.6 },
      palette: { preset: 'mono-amber' },
      post: { grain: 0.4, scanlines: 0.5, vignette: 0.4 },
    },
    thumb: ['#1c1917', '#fbbf24'],
  },
  {
    name: 'Vortex Drift',
    patch: {
      generator: 'vortex',
      params: { arms: 4, pull: 1.4 },
      palette: { preset: 'fire' },
      warps: [{ type: 'swirl', amount: 1.2, audio: 'low' }],
      audio: [{ band: 'low', target: 'speed', amount: 0.7 }],
    },
    thumb: ['#450a0a', '#fb923c'],
  },
  {
    name: 'Wireframe Heroes',
    patch: {
      generator: 'rutt-etra',
      params: { lines: 64, depth: 0.3 },
      palette: { preset: 'ice' },
      audio: [{ band: 'level', target: 'brightness', amount: 0.7 }],
    },
    thumb: ['#0c1322', '#7dd3fc'],
  },
  {
    name: 'Spirograph',
    patch: {
      generator: 'spirograph',
      params: { a: 6, b: 3, d: 0.7 },
      palette: { preset: 'acid' },
      motion: { rotate: 0.3 },
      audio: [{ band: 'beat', target: 'brightness', amount: 0.6 }],
    },
    thumb: ['#1a2e05', '#a3e635'],
  },
  {
    name: 'Noise Flow',
    patch: {
      generator: 'noise-flow',
      params: { zoom: 3, warp: 2 },
      palette: { preset: 'vapor' },
      audio: [{ band: 'level', target: 'brightness', amount: 0.5 }],
    },
    thumb: ['#0f172a', '#a78bfa'],
  },
  {
    name: 'Truchet Maze',
    patch: {
      generator: 'truchet',
      params: { tiles: 12, width: 0.09 },
      palette: { preset: 'lasergrid' },
      audio: [{ band: 'mid', target: 'brightness', amount: 0.5 }],
    },
    thumb: ['#082f49', '#38bdf8'],
  },
  {
    name: 'Hex Pulse',
    patch: {
      generator: 'hex-pulse',
      params: { cells: 10 },
      palette: { preset: 'miami' },
      audio: [
        { band: 'beat-low', target: 'scale', amount: 0.5 },
        { band: 'beat', target: 'brightness', amount: 0.7 },
      ],
    },
    thumb: ['#3b0764', '#f472b6'],
  },
];

// ---------------------------------------------------------------------------
// Procedural fly-through scenes — terrain heightfields / tunnel walls.
// Surface expressions use only the safe subset compiled by lib/expr.
// ---------------------------------------------------------------------------
interface SceneSeed {
  name: string;
  spec: SceneSpec;
  thumb: [string, string];
}

const SCENES: SceneSeed[] = [
  {
    name: 'Dune Field',
    spec: {
      kind: 'terrain',
      surface: 'abs(sin(x*0.18)*cos(z*0.15))*1.3+0.3',
      amplitude: 2.4,
      palette: ['#1e1b4b', '#f0abfc', '#0f0a1f'],
    },
    thumb: ['#1e1b4b', '#f0abfc'],
  },
  {
    name: 'Razor Peaks',
    spec: {
      kind: 'terrain',
      surface: 'pow(abs(sin(x*0.3)+sin(z*0.27)),2)*0.7',
      amplitude: 3,
      palette: ['#020617', '#38bdf8', '#060a14'],
    },
    thumb: ['#020617', '#38bdf8'],
  },
  {
    name: 'Wormhole',
    spec: {
      kind: 'tunnel',
      surface: 'sin(a*6+z*0.4)*0.6',
      amplitude: 2,
      palette: ['#3b0764', '#22d3ee', '#0a0118'],
    },
    thumb: ['#3b0764', '#22d3ee'],
  },
  {
    name: 'Spoke Tunnel',
    spec: {
      kind: 'tunnel',
      surface: 'abs(sin(a*8))*0.8+sin(z*0.3)*0.3',
      amplitude: 1.8,
      palette: ['#450a0a', '#fbbf24', '#140404'],
    },
    thumb: ['#450a0a', '#fbbf24'],
  },
];

// ---------------------------------------------------------------------------
// Thumbnails & data helpers.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Sprites — neon glyphs drawn at 512² on a transparent ground, with a
// black-flattened thumbnail for the library tile.
// ---------------------------------------------------------------------------
interface SpriteSeed {
  name: string;
  draw: (ctx: CanvasRenderingContext2D, size: number) => void;
}

function neon(ctx: CanvasRenderingContext2D, color: string, blur: number, width: number) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.lineWidth = width;
}

const SPRITES: SpriteSeed[] = [
  {
    // neon ring with a five-pointed star inside
    name: 'Neon Star',
    draw: (ctx, size) => {
      const c = size / 2;
      neon(ctx, '#22d3ee', 45, 14);
      for (let pass = 0; pass < 2; pass += 1) {
        ctx.beginPath();
        ctx.arc(c, c, 175, 0, Math.PI * 2);
        ctx.stroke();
      }
      neon(ctx, '#e879f9', 38, 14);
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
    },
  },
  {
    // concentric rings with a glowing pupil — a hypnotic "eye"
    name: 'Halo Eye',
    draw: (ctx, size) => {
      const c = size / 2;
      neon(ctx, '#a3e635', 30, 10);
      for (let r = 60; r <= 200; r += 35) {
        ctx.beginPath();
        ctx.arc(c, c, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      neon(ctx, '#f472b6', 50, 10);
      ctx.beginPath();
      ctx.arc(c, c, 40, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    // glowing triangle with an inner echo — a prism
    name: 'Prism',
    draw: (ctx, size) => {
      const c = size / 2;
      const tri = (scale: number) => {
        const p = new Path2D();
        for (let i = 0; i < 3; i += 1) {
          const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
          const x = c + 190 * scale * Math.cos(a);
          const y = c + 190 * scale * Math.sin(a);
          if (i === 0) p.moveTo(x, y);
          else p.lineTo(x, y);
        }
        p.closePath();
        return p;
      };
      neon(ctx, '#e879f9', 42, 16);
      ctx.stroke(tri(1));
      neon(ctx, '#22d3ee', 30, 10);
      ctx.stroke(tri(0.55));
    },
  },
  {
    // diagonal lattice of diamonds
    name: 'Lattice',
    draw: (ctx, size) => {
      neon(ctx, '#5eead4', 22, 6);
      const step = 64;
      for (let d = -size; d < size * 2; d += step) {
        ctx.beginPath();
        ctx.moveTo(d, 0);
        ctx.lineTo(d + size, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(d + size, 0);
        ctx.lineTo(d, size);
        ctx.stroke();
      }
    },
  },
  {
    // jagged lightning bolt
    name: 'Bolt',
    draw: (ctx, size) => {
      const c = size / 2;
      neon(ctx, '#fde047', 48, 4);
      const bolt = new Path2D();
      const pts: [number, number][] = [
        [c + 30, 60],
        [c - 50, c],
        [c, c],
        [c - 40, size - 60],
        [c + 70, c - 40],
        [c + 10, c - 40],
      ];
      pts.forEach(([x, y], i) => (i === 0 ? bolt.moveTo(x, y) : bolt.lineTo(x, y)));
      bolt.closePath();
      ctx.fill(bolt);
      ctx.fill(bolt);
    },
  },
];

function makeSprite(seed: SpriteSeed): { bytes: Uint8Array; thumbnail: string } {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  seed.draw(ctx, size);

  // thumbnail: the image flattened onto black at library size
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

// ---------------------------------------------------------------------------
// Models — binary STL meshes (STLLoader recomputes vertex normals on load).
// ---------------------------------------------------------------------------
type Vec3 = [number, number, number];

function trisToSTL(tris: Vec3[][]): Uint8Array {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((tri, k) => {
    let o = 84 + k * 50;
    [[0, 0, 0] as Vec3, ...tri].forEach((vec) => {
      dv.setFloat32(o, vec[0], true);
      dv.setFloat32(o + 4, vec[1], true);
      dv.setFloat32(o + 8, vec[2], true);
      o += 12;
    });
  });
  return new Uint8Array(buf);
}

function gridMesh(segU: number, segV: number, point: (i: number, j: number) => Vec3): Uint8Array {
  const tris: Vec3[][] = [];
  for (let i = 0; i < segU; i += 1) {
    for (let j = 0; j < segV; j += 1) {
      const a = point(i, j);
      const b = point(i + 1, j);
      const c = point(i + 1, j + 1);
      const d = point(i, j + 1);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  return trisToSTL(tris);
}

function makeTorusSTL(R = 1.0, r = 0.45, segU = 48, segV = 24): Uint8Array {
  return gridMesh(segU, segV, (i, j) => {
    const u = (i / segU) * Math.PI * 2;
    const v = (j / segV) * Math.PI * 2;
    return [
      Math.cos(u) * (R + r * Math.cos(v)),
      Math.sin(u) * (R + r * Math.cos(v)),
      r * Math.sin(v),
    ];
  });
}

// UV sphere; `spikes` displaces the radius with a periodic bump for a spiky ball
function makeSphereSTL(R = 1, segU = 40, segV = 24, spikes = 0): Uint8Array {
  return gridMesh(segU, segV, (i, j) => {
    const u = (i / segU) * Math.PI * 2;
    const v = (j / segV) * Math.PI;
    const rad = R * (1 + spikes * Math.max(0, Math.sin(u * 6) * Math.sin(v * 5)));
    return [Math.sin(v) * Math.cos(u) * rad, Math.cos(v) * rad, Math.sin(v) * Math.sin(u) * rad];
  });
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
  return gridMesh(segX, segZ, (i, j) => {
    const x = (i / segX - 0.5) * W;
    const z = (j / segZ) * D;
    return [x, height(x, z), z];
  });
}

interface ModelSeed {
  name: string;
  bytes: Uint8Array;
  thumb: [string, string];
}

const MODELS: ModelSeed[] = [
  { name: 'Torus', bytes: makeTorusSTL(), thumb: ['#0f172a', '#10b981'] },
  { name: 'Sphere', bytes: makeSphereSTL(), thumb: ['#0c4a6e', '#38bdf8'] },
  { name: 'Spike Ball', bytes: makeSphereSTL(1, 40, 24, 0.35), thumb: ['#3b0764', '#e879f9'] },
  // right-click -> "Landscape on …" stages this as fly-over terrain
  { name: 'Vapor Terrain', bytes: makeTerrainSTL(), thumb: ['#2e1065', '#db2777'] },
];

// ---------------------------------------------------------------------------
// Deck presets — ten arrangements, each highlighting a feature. Channels are
// built once the asset ids are known, via the resolver maps below.
// ---------------------------------------------------------------------------
const cfg = (over: DeckChannelConfig): DeckChannelConfig => ({ ...defaultChannelConfig(), ...over });
const aut = (over: Partial<AutomationMap>): AutomationMap => ({ ...makeDefaultAut(), ...over });
const liveLoop = (lanes: DeckLoop['lanes']): DeckLoop => ({
  playing: true,
  blocks: 1,
  divider: 4,
  lanes,
});
const swing = (lo: number, hi: number): LoopPoint[] => [
  { t: 0, v: lo, bend: 0 },
  { t: 0.5, v: hi, bend: 0 },
  { t: 1, v: lo, bend: 0 },
];

interface Ids {
  shader: (name: string) => string;
  sprite: (name: string) => string;
  scene: (name: string) => string;
  model: (name: string) => string;
}

function buildDecks({ shader, sprite, scene, model }: Ids): { name: string; channels: DeckChannelConfig[] }[] {
  return [
    {
      // primary — assigned to scene 0 on first launch. Layered shader + model +
      // sprite so it reads immediately and shows compositing.
      name: EXAMPLE_DECK_NAME,
      channels: [
        cfg({ shaderId: shader('Plasma Flow'), layer: 4, opacity: 1, prompt: 'flowing plasma waves on the bass' }),
        cfg({
          shaderId: shader('Neon Rings'),
          layer: 2,
          opacity: 0.45,
          fx: { ...DEFAULT_FX, hue: 40 },
          filter: { ...DEFAULT_FILTER, kind: 'kaleido', amount: 0.45 },
        }),
        cfg({
          modelId: model('Torus'),
          layer: 3,
          opacity: 0.6,
          tile: false,
          light: { ...DEFAULT_LIGHT, angle: 20 },
          aut: aut({ rot: { amt: 0.35, audio: false }, dst: { amt: 0.3, audio: true } }),
        }),
        cfg({
          spriteId: sprite('Neon Star'),
          layer: 1,
          opacity: 0.85,
          tile: false,
          size: { x: 0.6, y: 0.6 },
          aut: aut({ scl: { amt: 0.55, audio: true }, rot: { amt: 0.12, audio: false } }),
        }),
      ],
    },
    {
      // audio reactivity: strong band routing + audio-coupled automation
      name: EX('Bass Bloom'),
      channels: [
        cfg({ shaderId: shader('Acid Lava'), layer: 4, opacity: 1, fx: { ...DEFAULT_FX, band: 'low', amt: 1.5 } }),
        cfg({
          spriteId: sprite('Halo Eye'),
          layer: 1,
          opacity: 0.8,
          tile: false,
          fx: { ...DEFAULT_FX, band: 'beat' },
          aut: aut({ scl: { amt: 0.7, audio: true } }),
        }),
        cfg({
          modelId: model('Spike Ball'),
          layer: 2,
          opacity: 0.7,
          tile: false,
          light: { ...DEFAULT_LIGHT, brightness: 1.3 },
          aut: aut({ dst: { amt: 0.6, audio: true }, rot: { amt: 0.2, audio: false } }),
        }),
        cfg({ shaderId: shader('Hyperspace'), layer: 3, opacity: 0.4 }),
      ],
    },
    {
      // per-channel post filters: four kinds at once
      name: EX('Filter Lab'),
      channels: [
        cfg({ shaderId: shader('Stained Glass'), layer: 4, opacity: 1, filter: { ...DEFAULT_FILTER, kind: 'kaleido', amount: 0.5, param2: 0.4 } }),
        cfg({ shaderId: shader('Plasma Flow'), layer: 3, opacity: 0.55, filter: { ...DEFAULT_FILTER, kind: 'rgbSplit', amount: 0.6 } }),
        cfg({ shaderId: shader('Neon Rings'), layer: 2, opacity: 0.5, filter: { ...DEFAULT_FILTER, kind: 'swirl', amount: 0.7, param2: 0.5 } }),
        cfg({ spriteId: sprite('Prism'), layer: 1, opacity: 0.7, tile: false, filter: { ...DEFAULT_FILTER, kind: 'ripple', amount: 0.5 } }),
      ],
    },
    {
      // warps & symmetry
      name: EX('Kaleido Temple'),
      channels: [
        cfg({ shaderId: shader('Temple Mandala'), layer: 4, opacity: 1 }),
        cfg({ shaderId: shader('Truchet Maze'), layer: 3, opacity: 0.5, filter: { ...DEFAULT_FILTER, kind: 'kaleido', amount: 0.6 } }),
        cfg({ shaderId: shader('Hex Pulse'), layer: 2, opacity: 0.45 }),
        cfg({ spriteId: sprite('Lattice'), layer: 1, opacity: 0.5, tile: true, fx: { ...DEFAULT_FX, hue: 120 } }),
      ],
    },
    {
      // landscape (fly-over) mode + a procedural scene + a synth sky
      name: EX('Canyon Run'),
      channels: [
        cfg({
          landscapeId: model('Vapor Terrain'),
          layer: 4,
          opacity: 1,
          light: { ...DEFAULT_LIGHT, brightness: 1.1, angle: 35 },
          pos: { x: 0, y: 0.1 },
        }),
        cfg({ shaderId: shader('Synthwave Sun'), layer: 3, opacity: 0.55 }),
        cfg({ sceneId: scene('Dune Field'), layer: 2, opacity: 0.35 }),
        cfg({
          spriteId: sprite('Bolt'),
          layer: 1,
          opacity: 0.4,
          tile: false,
          size: { x: 0.4, y: 0.4 },
          pos: { x: 0.25, y: 0.25 },
          aut: aut({ flk: { amt: 0.6, audio: true } }),
        }),
      ],
    },
    {
      // fly-through tunnel scenes
      name: EX('Wormhole'),
      channels: [
        cfg({ sceneId: scene('Wormhole'), layer: 4, opacity: 1 }),
        cfg({ shaderId: shader('Vortex Drift'), layer: 3, opacity: 0.45 }),
        cfg({ sceneId: scene('Spoke Tunnel'), layer: 2, opacity: 0.35 }),
        cfg({ spriteId: sprite('Halo Eye'), layer: 1, opacity: 0.55, tile: false, aut: aut({ scl: { amt: 0.4, audio: true } }) }),
      ],
    },
    {
      // beat-locked loops — set a BPM in the top bar and watch them pump
      name: EX('Loop Engine'),
      channels: [
        cfg({ shaderId: shader('Spirograph'), layer: 4, opacity: 1, loop: liveLoop({ hue: [{ t: 0, v: 0, bend: 0 }, { t: 1, v: 1, bend: 0 }] }) }),
        cfg({ shaderId: shader('Plasma Flow'), layer: 3, opacity: 0.6, loop: liveLoop({ scale: swing(0.3, 0.8) }) }),
        cfg({ shaderId: shader('Temple Mandala'), layer: 2, opacity: 0.5, loop: liveLoop({ opacity: swing(0.2, 1) }) }),
        cfg({ spriteId: sprite('Prism'), layer: 1, opacity: 0.7, tile: false, loop: liveLoop({ posX: swing(0.2, 0.8) }) }),
      ],
    },
    {
      // three lit 3D models orbiting over a shader backdrop
      name: EX('Orbit'),
      channels: [
        cfg({ shaderId: shader('Pool Caustics'), layer: 4, opacity: 1 }),
        cfg({
          modelId: model('Torus'),
          layer: 3,
          opacity: 0.8,
          tile: false,
          scale: 1.1,
          light: { ...DEFAULT_LIGHT, angle: 25 },
          aut: aut({ rot: { amt: 0.4, audio: false }, tlt: { amt: 0.2, audio: false } }),
        }),
        cfg({
          modelId: model('Sphere'),
          layer: 2,
          opacity: 0.7,
          tile: false,
          pos: { x: 0.35, y: 0 },
          light: { ...DEFAULT_LIGHT, brightness: 1.4, angle: 120 },
          aut: aut({ dst: { amt: 0.4, audio: true }, rot: { amt: 0.2, audio: false } }),
        }),
        cfg({
          modelId: model('Spike Ball'),
          layer: 1,
          opacity: 0.6,
          tile: false,
          pos: { x: -0.35, y: 0 },
          aut: aut({ rot: { amt: 0.3, audio: true }, skw: { amt: 0.2, audio: false } }),
        }),
      ],
    },
    {
      // retro: scanlines, edge and rgb-split filters over CRT-style generators
      name: EX('VHS Nightmare'),
      channels: [
        cfg({ shaderId: shader('VHS Signal'), layer: 4, opacity: 1, filter: { ...DEFAULT_FILTER, kind: 'scanlines', amount: 0.5 } }),
        cfg({ shaderId: shader('Matrix Rain'), layer: 3, opacity: 0.5 }),
        cfg({ shaderId: shader('Wireframe Heroes'), layer: 2, opacity: 0.5, filter: { ...DEFAULT_FILTER, kind: 'edge', amount: 0.6 } }),
        cfg({ spriteId: sprite('Halo Eye'), layer: 1, opacity: 0.45, tile: false, filter: { ...DEFAULT_FILTER, kind: 'rgbSplit', amount: 0.5 } }),
      ],
    },
    {
      // organic feedback trails (Acid Lava carries trail/feedZoom post)
      name: EX('Acid Melt'),
      channels: [
        cfg({ shaderId: shader('Acid Lava'), layer: 4, opacity: 1 }),
        cfg({ shaderId: shader('Pool Caustics'), layer: 3, opacity: 0.5 }),
        cfg({ shaderId: shader('Noise Flow'), layer: 2, opacity: 0.5, filter: { ...DEFAULT_FILTER, kind: 'swirl', amount: 0.6 } }),
        cfg({
          spriteId: sprite('Prism'),
          layer: 1,
          opacity: 0.6,
          tile: false,
          aut: aut({ rot: { amt: 0.3, audio: true }, scl: { amt: 0.3, audio: true } }),
        }),
      ],
    },
  ];
}

// Every name this module seeds, so dedupeExampleEntries recognises its own
// output (and re-seed duplicates) without a hand-maintained list.
const EXAMPLE_NAMES = new Set<string>([
  ...SHADERS.map((s) => EX(s.name)),
  ...SCENES.map((s) => EX(s.name)),
  ...SPRITES.map((s) => EX(s.name)),
  ...MODELS.map((m) => EX(m.name)),
  EXAMPLE_DECK_NAME,
  ...['Bass Bloom', 'Filter Lab', 'Kaleido Temple', 'Canyon Run', 'Wormhole', 'Loop Engine', 'Orbit', 'VHS Nightmare', 'Acid Melt'].map(EX),
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

/** Creates the example entries + deck presets; returns them newest-first. */
export async function seedExampleLibrary(): Promise<{ deck: DeckEntry; entries: LibraryEntry[] }> {
  // assets first, so the decks can reference their ids
  const shaders = await Promise.all(
    SHADERS.map((s) =>
      saveShader({ name: EX(s.name), patch: s.patch, screenshot: gradientThumb(s.name.toUpperCase(), s.thumb[0], s.thumb[1]) }),
    ),
  );
  const scenes = await Promise.all(
    SCENES.map((s) =>
      saveScene({ name: EX(s.name), spec: s.spec, screenshot: gradientThumb(s.name.toUpperCase(), s.thumb[0], s.thumb[1]) }),
    ),
  );
  const sprites = await Promise.all(
    SPRITES.map((s) => {
      const art = makeSprite(s);
      return saveAssetFromBuffer({ kind: 'sprite', name: EX(s.name), bytes: art.bytes, ext: '.png', screenshot: art.thumbnail });
    }),
  );
  const models = await Promise.all(
    MODELS.map((m) =>
      saveAssetFromBuffer({ kind: 'model', name: EX(m.name), bytes: m.bytes, ext: '.stl', screenshot: gradientThumb(m.name.toUpperCase(), m.thumb[0], m.thumb[1]) }),
    ),
  );

  const resolve = (defs: { name: string }[], saved: LibraryEntry[]) => {
    const map = new Map<string, string>();
    defs.forEach((d, i) => map.set(d.name, saved[i].id));
    return (name: string) => {
      const id = map.get(name);
      if (!id) throw new Error(`[Vizzy] example asset not found: ${name}`);
      return id;
    };
  };
  const ids: Ids = {
    shader: resolve(SHADERS, shaders),
    scene: resolve(SCENES, scenes),
    sprite: resolve(SPRITES, sprites),
    model: resolve(MODELS, models),
  };

  const deckDefs = buildDecks(ids);
  const decks = await Promise.all(
    deckDefs.map((d) =>
      saveDeck({ name: d.name, channels: d.channels, screenshot: gradientThumb(d.name.replace('Example · ', '').toUpperCase(), '#155e75', '#701a75') }),
    ),
  );

  const entries: LibraryEntry[] = [...decks, ...models, ...sprites, ...scenes, ...shaders];
  return { deck: decks[0], entries };
}
