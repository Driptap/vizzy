import { describe, it, expect } from 'vitest';
import { buildSceneBuffers } from './sceneGenerator';

const terrainSpec = {
  kind: 'terrain',
  surface: 'abs(sin(x * 0.3)) * min(1, abs(x) / 8)',
  amplitude: 3,
  palette: ['#ff71ce', '#01cdfe', '#2d00f7'],
};

const tunnelSpec = {
  kind: 'tunnel',
  surface: 'sin(a * 6) * 0.5 + sin(z * 0.4) * 0.5',
  amplitude: 2,
  palette: ['#1a0533', '#05ffa1', '#000000'],
};

const vertexCount = (buffers) => buffers.positions.length / 3;
const getX = (b, i) => b.positions[i * 3];
const getY = (b, i) => b.positions[i * 3 + 1];

describe('buildSceneBuffers — terrain', () => {
  it('builds an indexed, vertex-coloured grid centred on the z axis', () => {
    const buffers = buildSceneBuffers(terrainSpec);

    expect(vertexCount(buffers)).toBe(73 * 61); // (segX+1) * (segZ+1)
    expect(buffers.colors.length).toBe(buffers.positions.length);
    expect(buffers.indices.length).toBe(72 * 60 * 6);

    // centred in x and z, grounded at y >= 0
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < vertexCount(buffers); i += 1) {
      minX = Math.min(minX, getX(buffers, i));
      maxX = Math.max(maxX, getX(buffers, i));
      minY = Math.min(minY, getY(buffers, i));
      maxY = Math.max(maxY, getY(buffers, i));
    }
    expect(minX).toBeCloseTo(-24);
    expect(maxX).toBeCloseTo(24);
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(maxY).toBeLessThanOrEqual(terrainSpec.amplitude * 2);
    expect(maxY).toBeGreaterThan(0.5); // the surface actually has relief
  });

  it('keeps the valley corridor flat at x = 0', () => {
    const buffers = buildSceneBuffers(terrainSpec);
    for (let i = 0; i < vertexCount(buffers); i += 1) {
      if (Math.abs(getX(buffers, i)) < 0.01) expect(getY(buffers, i)).toBeCloseTo(0);
    }
  });

  it('vertex colours lerp the first two palette entries', () => {
    const buffers = buildSceneBuffers(terrainSpec);
    for (const c of buffers.colors) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    // tallest vertex carries the second palette colour (#01cdfe -> r ~ 1/255)
    let top = 0;
    for (let i = 0; i < vertexCount(buffers); i += 1) {
      if (getY(buffers, i) > getY(buffers, top)) top = i;
    }
    expect(buffers.colors[top * 3]).toBeCloseTo(0x01 / 255, 2);
  });
});

describe('buildSceneBuffers — tunnel', () => {
  it('builds a tube around the z axis the camera can fly through', () => {
    const buffers = buildSceneBuffers(tunnelSpec);
    expect(vertexCount(buffers)).toBe(49 * 61);

    for (let i = 0; i < vertexCount(buffers); i += 1) {
      const r = Math.hypot(getX(buffers, i), getY(buffers, i));
      expect(r).toBeGreaterThanOrEqual(0.6); // never collapses onto the camera
      expect(r).toBeLessThanOrEqual(3 + tunnelSpec.amplitude * 0.3 + 0.01);
    }
  });

  it('a hostile surface expression cannot produce non-finite vertices', () => {
    const buffers = buildSceneBuffers({ ...tunnelSpec, surface: '1 / 0 + log(0)' });
    for (const p of buffers.positions) {
      expect(Number.isFinite(p)).toBe(true);
    }
  });
});

describe('buildSceneBuffers — validation', () => {
  it('throws on an uncompilable surface so staging can fail cleanly', () => {
    expect(() =>
      buildSceneBuffers({ ...terrainSpec, surface: 'require("fs")' }),
    ).toThrow(); // quote rejected by the tokenizer before "require" even parses
    expect(() =>
      buildSceneBuffers({ ...terrainSpec, surface: 'require(z)' }),
    ).toThrow(/Unknown function/);
  });
});
