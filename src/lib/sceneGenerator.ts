// Synthesizes fly-through geometry from an LLM-generated SceneSpec: a
// vertex-coloured terrain tile (fly over) or tunnel tube (fly through).
// Both are built centred on the z axis so the engine's mirrored two-tile
// leapfrog loops them seamlessly.
import * as THREE from 'three';
import { compileExpression, type ExprFn } from './expr';
import type { SceneSpec } from '../types';

export const TERRAIN_VARS = ['x', 'z'];
export const TUNNEL_VARS = ['a', 'z'];

// world dimensions of one tile; matched to the landscape fly-over framing
const TERRAIN = { width: 48, depth: 40, segX: 72, segZ: 60 };
const TUNNEL = { radius: 3, depth: 40, segA: 48, segZ: 60 };

export const surfaceVarsFor = (kind: SceneSpec['kind']): string[] =>
  kind === 'tunnel' ? TUNNEL_VARS : TERRAIN_VARS;

const paletteColors = (spec: SceneSpec): [THREE.Color, THREE.Color] => [
  new THREE.Color(spec.palette[0]),
  new THREE.Color(spec.palette[1]),
];

const makeMesh = (geometry: THREE.BufferGeometry): THREE.Group => {
  geometry.computeVertexNormals();
  // Lambert keeps the palette vivid but responds to the deck light rig, so
  // the LIGHT channel controls (brightness / key direction) shape the scene
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
};

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

function buildTerrain(spec: SceneSpec, surface: ExprFn): THREE.Group {
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
  const scratch = new THREE.Color();
  heights.forEach((h) => {
    scratch.lerpColors(low, high, h / maxH);
    colors.push(scratch.r, scratch.g, scratch.b);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(gridIndices(segX, segZ));
  return makeMesh(geometry);
}

function buildTunnel(spec: SceneSpec, surface: ExprFn): THREE.Group {
  const { radius, depth, segA, segZ } = TUNNEL;
  const positions: number[] = [];
  const colors: number[] = [];
  const [wall, glow] = paletteColors(spec);
  const scratch = new THREE.Color();

  for (let j = 0; j <= segZ; j += 1) {
    for (let i = 0; i <= segA; i += 1) {
      const a = (i / segA) * Math.PI * 2;
      const z = (j / segZ - 0.5) * depth;
      // surface modulates the wall inward/outward; floor keeps it a tube
      const offset = Math.max(-0.8, Math.min(1, surface({ a, z })));
      const r = Math.max(0.6, radius + offset * spec.amplitude * 0.3);
      positions.push(Math.cos(a) * r, Math.sin(a) * r, z);
      scratch.lerpColors(wall, glow, (offset + 0.8) / 1.8);
      colors.push(scratch.r, scratch.g, scratch.b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(gridIndices(segA, segZ));
  return makeMesh(geometry);
}

/** @throws when the spec's surface expression doesn't compile */
export function buildSceneObject(spec: SceneSpec): THREE.Group {
  const surface = compileExpression(spec.surface, surfaceVarsFor(spec.kind));
  return spec.kind === 'tunnel' ? buildTunnel(spec, surface) : buildTerrain(spec, surface);
}
