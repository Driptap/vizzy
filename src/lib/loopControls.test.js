import { describe, it, expect } from 'vitest';
import {
  sampleLane,
  flatLane,
  addPoint,
  movePoint,
  removePoint,
  setBend,
  LOOP_CONTROLS,
  defaultLoop,
} from './loopControls';

const pt = (t, v, bend = 0) => ({ t, v, bend });

describe('sampleLane', () => {
  it('holds flat lanes at their value', () => {
    const lane = flatLane(0.7);
    [0, 0.25, 0.5, 1].forEach((u) => expect(sampleLane(lane, u)).toBeCloseTo(0.7));
  });

  it('interpolates linearly between points at bend 0', () => {
    const lane = [pt(0, 0), pt(1, 1)];
    expect(sampleLane(lane, 0.25)).toBeCloseTo(0.25);
    expect(sampleLane(lane, 0.5)).toBeCloseTo(0.5);
  });

  it('bend +1 eases late, bend -1 eases early', () => {
    const late = [pt(0, 0, 1), pt(1, 1)];
    const early = [pt(0, 0, -1), pt(1, 1)];
    expect(sampleLane(late, 0.5)).toBeLessThan(0.2); // u^4
    expect(sampleLane(early, 0.5)).toBeGreaterThan(0.8); // u^0.25
    expect(sampleLane(late, 0)).toBeCloseTo(0);
    expect(sampleLane(late, 1)).toBeCloseTo(1);
  });

  it('walks multi-segment lanes with per-segment bends', () => {
    const lane = [pt(0, 0), pt(0.5, 1, 1), pt(1, 0)];
    expect(sampleLane(lane, 0.25)).toBeCloseTo(0.5); // linear up
    expect(sampleLane(lane, 0.5)).toBeCloseTo(1);
    expect(sampleLane(lane, 0.75)).toBeCloseTo(1 - 0.5 ** 4); // eased down
  });

  it('holds the edge values outside the lane and clamps the phase', () => {
    const lane = [pt(0.25, 0.2), pt(0.75, 0.9)];
    expect(sampleLane(lane, 0)).toBeCloseTo(0.2);
    expect(sampleLane(lane, 1)).toBeCloseTo(0.9);
    expect(sampleLane(lane, -5)).toBeCloseTo(0.2);
    expect(sampleLane([], 0.5)).toBe(0);
  });
});

describe('lane editing operations', () => {
  it('addPoint keeps the lane sorted and reports the insert index', () => {
    const { points, index } = addPoint([pt(0, 0), pt(1, 1)], 0.5, 0.8);
    expect(points.map((p) => p.t)).toEqual([0, 0.5, 1]);
    expect(index).toBe(1);
    expect(points[1].v).toBe(0.8);
  });

  it('movePoint clamps between neighbours and pins the endpoints', () => {
    const lane = [pt(0, 0), pt(0.5, 0.5), pt(1, 1)];
    const moved = movePoint(lane, 1, 0.9, 2);
    expect(moved[1].t).toBeLessThanOrEqual(1);
    expect(moved[1].v).toBe(1); // value clamped to 0..1

    const endpoint = movePoint(lane, 0, 0.4, 0.3);
    expect(endpoint[0].t).toBe(0); // endpoints never leave the loop edges
    expect(endpoint[0].v).toBe(0.3); // but their value moves freely
  });

  it('removePoint refuses to drop below two points or remove endpoints', () => {
    const lane = [pt(0, 0), pt(0.5, 0.5), pt(1, 1)];
    expect(removePoint(lane, 1)).toHaveLength(2);
    expect(removePoint(lane, 0)).toHaveLength(3);
    expect(removePoint([pt(0, 0), pt(1, 1)], 1)).toHaveLength(2);
  });

  it('setBend clamps curvature to ±1', () => {
    const lane = [pt(0, 0), pt(1, 1)];
    expect(setBend(lane, 0, 9)[0].bend).toBe(1);
    expect(setBend(lane, 0, -9)[0].bend).toBe(-1);
  });
});

describe('loop model', () => {
  it('defaults: stopped, 4 blocks of 1 beat, no lanes', () => {
    expect(defaultLoop()).toEqual({ playing: false, blocks: 4, divider: 1, lanes: {} });
  });

  it('exposes every automatable channel control', () => {
    const ids = LOOP_CONTROLS.map((c) => c.id);
    expect(ids).toEqual([
      'opacity', 'scale', 'sizeX', 'sizeY', 'posX', 'posY',
      'tilt', 'contrast', 'hue', 'sat', 'brightness', 'lightAngle',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('graph coordinate mapping', () => {
  it('maps pointer positions into lane space across the padded graph', async () => {
    const { normFromPointer } = await import('../components/LooperModal');
    const rect = { left: 100, top: 50, width: 560, height: 220 };
    // dead centre of the graph
    const mid = normFromPointer(rect, 100 + 280, 50 + 110);
    expect(mid.t).toBeCloseTo(0.5, 1);
    expect(mid.v).toBeCloseTo(0.5, 1);
    // outside the padding clamps to the lane edges, even when the svg is
    // rendered at a different size than its viewBox
    const tiny = { left: 0, top: 0, width: 280, height: 110 };
    expect(normFromPointer(tiny, -50, 999)).toEqual({ t: 0, v: 0 });
    expect(normFromPointer(tiny, 999, -50)).toEqual({ t: 1, v: 1 });
  });
});
