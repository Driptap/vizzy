import { describe, it, expect } from 'vitest';
// real three: geometry building is pure JS, no GL context needed
import { buildSceneObject } from './sceneGenerator';

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

describe('buildSceneObject — terrain', () => {
  it('builds an indexed, vertex-coloured grid centred on the z axis', () => {
    const group = buildSceneObject(terrainSpec);
    const mesh = group.children[0];
    const position = mesh.geometry.getAttribute('position');
    const color = mesh.geometry.getAttribute('color');

    expect(position.count).toBe(73 * 61); // (segX+1) * (segZ+1)
    expect(color.count).toBe(position.count);
    expect(mesh.geometry.getIndex().count).toBe(72 * 60 * 6);

    // centred in x and z, grounded at y >= 0
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      minX = Math.min(minX, position.getX(i));
      maxX = Math.max(maxX, position.getX(i));
      minY = Math.min(minY, position.getY(i));
      maxY = Math.max(maxY, position.getY(i));
    }
    expect(minX).toBeCloseTo(-24);
    expect(maxX).toBeCloseTo(24);
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(maxY).toBeLessThanOrEqual(terrainSpec.amplitude * 2);
    expect(maxY).toBeGreaterThan(0.5); // the surface actually has relief
  });

  it('keeps the valley corridor flat at x = 0', () => {
    const group = buildSceneObject(terrainSpec);
    const position = group.children[0].geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      if (Math.abs(position.getX(i)) < 0.01) expect(position.getY(i)).toBeCloseTo(0);
    }
  });

  it('uses a lit double-sided vertex-colour material so the rig can shape it', () => {
    const mesh = buildSceneObject(terrainSpec).children[0];
    expect(mesh.material.vertexColors).toBe(true);
    expect(mesh.material.type).toBe('MeshLambertMaterial');
    expect(mesh.geometry.getAttribute('normal')).toBeTruthy(); // lit materials need normals
  });
});

describe('buildSceneObject — tunnel', () => {
  it('builds a tube around the z axis the camera can fly through', () => {
    const group = buildSceneObject(tunnelSpec);
    const position = group.children[0].geometry.getAttribute('position');
    expect(position.count).toBe(49 * 61);

    for (let i = 0; i < position.count; i += 1) {
      const r = Math.hypot(position.getX(i), position.getY(i));
      expect(r).toBeGreaterThanOrEqual(0.6); // never collapses onto the camera
      expect(r).toBeLessThanOrEqual(3 + tunnelSpec.amplitude * 0.3 + 0.01);
    }
  });

  it('a hostile surface expression cannot produce non-finite vertices', () => {
    const group = buildSceneObject({ ...tunnelSpec, surface: '1 / 0 + log(0)' });
    const position = group.children[0].geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      expect(Number.isFinite(position.getX(i))).toBe(true);
      expect(Number.isFinite(position.getY(i))).toBe(true);
    }
  });
});

describe('buildSceneObject — validation', () => {
  it('throws on an uncompilable surface so staging can fail cleanly', () => {
    expect(() =>
      buildSceneObject({ ...terrainSpec, surface: 'require("fs")' }),
    ).toThrow(); // quote rejected by the tokenizer before "require" even parses
    expect(() =>
      buildSceneObject({ ...terrainSpec, surface: 'require(z)' }),
    ).toThrow(/Unknown function/);
    // tunnel expressions may not use terrain variables
    expect(() => buildSceneObject({ ...tunnelSpec, surface: 'x * 2' })).toThrow(
      /Unknown identifier/,
    );
  });
});
