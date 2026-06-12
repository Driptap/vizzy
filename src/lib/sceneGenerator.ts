// Synthesizes fly-through geometry from an LLM-generated SceneSpec: a
// vertex-coloured terrain tile (fly over) or tunnel tube (fly through).
// Both are built centred on the z axis so the engine's mirrored two-tile
// leapfrog loops them seamlessly. Pure arrays — the native core uploads
// them and computes normals.
import { compileExpression, type ExprFn } from './expr';
import type { SceneSpec } from '../types';

export const TERRAIN_VARS = ['x', 'z'];
export const TUNNEL_VARS = ['a', 'z'];

// world dimensions of one tile; matched to the landscape fly-over framing
const TERRAIN = { width: 48, depth: 40, segX: 72, segZ: 60 };
const TUNNEL = { radius: 3, depth: 40, segA: 48, segZ: 60 };

export const surfaceVarsFor = (kind: SceneSpec['kind']): string[] =>
  kind === 'tunnel' ? TUNNEL_VARS : TERRAIN_VARS;

export interface SceneBuffers {
  positions: number[];
  colors: number[];
  indices: number[];
}

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
};

const lerpRgb = (a: Rgb, b: Rgb, v: number): Rgb => [
  a[0] + (b[0] - a[0]) * v,
  a[1] + (b[1] - a[1]) * v,
  a[2] + (b[2] - a[2]) * v,
];

const paletteColors = (spec: SceneSpec): [Rgb, Rgb] => [
  hexToRgb(spec.palette[0]),
  hexToRgb(spec.palette[1]),
];

const gridIndices = (cols: number, rows: number): number[] => {
  const indices: number[] = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 2;
      const d = a + cols + 1;
      indices.push(a, b, c, a, c, d);
    }
  }
  return indices;
};

function buildTerrain(spec: SceneSpec, surface: ExprFn): SceneBuffers {
  const { width, depth, segX, segZ } = TERRAIN;
  const positions: number[] = [];
  const heights: number[] = [];

  for (let j = 0; j <= segZ; j += 1) {
    for (let i = 0; i <= segX; i += 1) {
      const x = (i / segX - 0.5) * width;
      const z = (j / segZ - 0.5) * depth;
      const h = Math.max(0, Math.min(2, surface({ x, z }))) * spec.amplitude;
      positions.push(x, h, z);
      heights.push(h);
    }
  }

  const maxH = Math.max(0.001, ...heights);
  const [low, high] = paletteColors(spec);
  const colors: number[] = [];
  heights.forEach((h) => {
    colors.push(...lerpRgb(low, high, h / maxH));
  });

  return { positions, colors, indices: gridIndices(segX, segZ) };
}

function buildTunnel(spec: SceneSpec, surface: ExprFn): SceneBuffers {
  const { radius, depth, segA, segZ } = TUNNEL;
  const positions: number[] = [];
  const colors: number[] = [];
  const [wall, glow] = paletteColors(spec);

  for (let j = 0; j <= segZ; j += 1) {
    for (let i = 0; i <= segA; i += 1) {
      const a = (i / segA) * Math.PI * 2;
      const z = (j / segZ - 0.5) * depth;
      // surface modulates the wall inward/outward; floor keeps it a tube
      const offset = Math.max(-0.8, Math.min(1, surface({ a, z })));
      const r = Math.max(0.6, radius + offset * spec.amplitude * 0.3);
      positions.push(Math.cos(a) * r, Math.sin(a) * r, z);
      colors.push(...lerpRgb(wall, glow, (offset + 0.8) / 1.8));
    }
  }

  return { positions, colors, indices: gridIndices(segA, segZ) };
}

/** @throws when the spec's surface expression doesn't compile */
export function buildSceneBuffers(spec: SceneSpec): SceneBuffers {
  const surface = compileExpression(spec.surface, surfaceVarsFor(spec.kind));
  return spec.kind === 'tunnel' ? buildTunnel(spec, surface) : buildTerrain(spec, surface);
}
