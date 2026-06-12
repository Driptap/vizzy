// The looper's data model and pure lane math: DAW-style automation lanes of
// {t, v, bend} anchor points over a beat-locked loop. Everything here is
// engine- and UI-agnostic so both sides share one source of truth.
import type { DeckLoop, LoopControlId, LoopPoint } from '../types';

export const LOOP_MAX_BLOCKS = 8;
/** beats per block — the tempo divider in the editor */
export const LOOP_DIVIDERS = [0.5, 1, 2, 4];

export interface LoopControlMeta {
  id: LoopControlId;
  label: string;
  /** lanes apply absolutely except opacity, which multiplies the fader */
  hint?: string;
}

export const LOOP_CONTROLS: LoopControlMeta[] = [
  { id: 'opacity', label: 'FADER', hint: 'multiplies the channel fader' },
  { id: 'scale', label: 'SCALE' },
  { id: 'sizeX', label: 'W' },
  { id: 'sizeY', label: 'H' },
  { id: 'posX', label: 'POS X' },
  { id: 'posY', label: 'POS Y' },
  { id: 'tilt', label: 'TILT' },
  { id: 'contrast', label: 'CON' },
  { id: 'hue', label: 'HUE' },
  { id: 'sat', label: 'SAT' },
  { id: 'brightness', label: 'BRT' },
  { id: 'lightAngle', label: 'DIR' },
];

export const defaultLoop = (): DeckLoop => ({
  playing: false,
  blocks: 4,
  divider: 1,
  lanes: {},
});

/** A fresh lane: a flat line at the control's current (normalized) value. */
export const flatLane = (v: number): LoopPoint[] => [
  { t: 0, v: clamp01(v), bend: 0 },
  { t: 1, v: clamp01(v), bend: 0 },
];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Sample a lane at phase u (0..1). Segments ease with the LEADING point's
 * bend: 0 = linear, +1 bends hard late (slow start), -1 bends hard early —
 * the single-handle curvature model DAW automation editors use.
 */
export function sampleLane(points: LoopPoint[], u: number): number {
  if (!points.length) return 0;
  const x = clamp01(u);
  if (x <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (x >= last.t) return last.v;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (x <= b.t) {
      const span = b.t - a.t || 1e-9;
      const f = (x - a.t) / span;
      const eased = Math.pow(f, Math.pow(4, a.bend));
      return a.v + (b.v - a.v) * eased;
    }
  }
  return last.v;
}

/** Insert a point keeping the lane sorted; returns the new index too. */
export function addPoint(
  points: LoopPoint[],
  t: number,
  v: number,
): { points: LoopPoint[]; index: number } {
  const point: LoopPoint = { t: clamp01(t), v: clamp01(v), bend: 0 };
  const next = [...points, point].sort((a, b) => a.t - b.t);
  return { points: next, index: next.indexOf(point) };
}

/** Move a point, clamped between its neighbours so the lane stays sorted. */
export function movePoint(points: LoopPoint[], index: number, t: number, v: number): LoopPoint[] {
  return points.map((p, i) => {
    if (i !== index) return p;
    const lo = i === 0 ? 0 : points[i - 1].t;
    const hi = i === points.length - 1 ? 1 : points[i + 1].t;
    // endpoints stay pinned to the loop edges
    const tt = i === 0 ? 0 : i === points.length - 1 ? 1 : Math.min(hi, Math.max(lo, clamp01(t)));
    return { ...p, t: tt, v: clamp01(v) };
  });
}

/** Remove a point; a lane never drops below its two endpoints. */
export function removePoint(points: LoopPoint[], index: number): LoopPoint[] {
  if (points.length <= 2 || index === 0 || index === points.length - 1) return points;
  return points.filter((_, i) => i !== index);
}

/** Set the curvature of the segment LEAVING the given point, clamped ±1. */
export function setBend(points: LoopPoint[], segIndex: number, bend: number): LoopPoint[] {
  return points.map((p, i) =>
    i === segIndex ? { ...p, bend: Math.min(1, Math.max(-1, bend)) } : p,
  );
}
