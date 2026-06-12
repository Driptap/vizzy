import { useRef, useState } from 'react';
import {
  LOOP_CONTROLS,
  LOOP_DIVIDERS,
  LOOP_MAX_BLOCKS,
  addPoint,
  flatLane,
  movePoint,
  removePoint,
  sampleLane,
  setBend,
} from '../lib/loopControls';
import type { DeckLoop, LoopControlId, LoopPoint } from '../types';

const GRAPH_W = 560;
const GRAPH_H = 220;
const PAD = 10;

const toX = (t: number) => PAD + t * (GRAPH_W - PAD * 2);
const toY = (v: number) => PAD + (1 - v) * (GRAPH_H - PAD * 2);

/** Pointer position -> normalized lane coordinates (pure; tested directly). */
export function normFromPointer(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { t: number; v: number } {
  const x = ((clientX - rect.left) / (rect.width || 1)) * GRAPH_W;
  const y = ((clientY - rect.top) / (rect.height || 1)) * GRAPH_H;
  return {
    t: Math.min(1, Math.max(0, (x - PAD) / (GRAPH_W - PAD * 2))),
    v: Math.min(1, Math.max(0, 1 - (y - PAD) / (GRAPH_H - PAD * 2))),
  };
}

function lanePath(points: LoopPoint[]): string {
  const steps = 96;
  const parts: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    parts.push(`${i === 0 ? 'M' : 'L'} ${toX(t).toFixed(1)} ${toY(sampleLane(points, t)).toFixed(1)}`);
  }
  return parts.join(' ');
}

type Drag =
  | { kind: 'point'; index: number }
  | { kind: 'bend'; segIndex: number; startY: number; startBend: number };

interface LooperModalProps {
  deckLabel: string;
  loop: DeckLoop;
  /** current channel values, normalized 0..1, used to seed new lanes */
  currentValues: Partial<Record<LoopControlId, number>>;
  onChange: (loop: DeckLoop) => void;
  onClose: () => void;
}

/**
 * DAW-style automation editor for one deck's loop: enable a control to give
 * it a lane, then shape the lane on the graph — click adds a point, drag
 * moves it, double-click removes it, dragging a segment's diamond handle
 * bends the curve. The loop is blocks x divider beats long, beat-locked to
 * the global tempo.
 */
export function LooperModal({ deckLabel, loop, currentValues, onChange, onClose }: LooperModalProps) {
  const enabledIds = LOOP_CONTROLS.filter((c) => loop.lanes[c.id]).map((c) => c.id);
  const [selected, setSelected] = useState<LoopControlId | null>(enabledIds[0] ?? null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const lane = selected ? loop.lanes[selected] : undefined;

  const updateLane = (id: LoopControlId, points: LoopPoint[]) =>
    onChange({ ...loop, lanes: { ...loop.lanes, [id]: points } });

  const toggleControl = (id: LoopControlId) => {
    if (loop.lanes[id]) {
      const lanes = { ...loop.lanes };
      delete lanes[id];
      onChange({ ...loop, lanes });
      if (selected === id) setSelected(null);
    } else {
      updateLane(id, flatLane(currentValues[id] ?? 0.5));
      setSelected(id);
    }
  };

  const pointerNorm = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return normFromPointer(rect, e.clientX, e.clientY);
  };

  const handleGraphPointerDown = (e: React.PointerEvent) => {
    if (!selected || !lane) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const { t, v } = pointerNorm(e);
    const { points, index } = addPoint(lane, t, v);
    updateLane(selected, points);
    dragRef.current = { kind: 'point', index };
  };

  const handlePointPointerDown = (e: React.PointerEvent, index: number) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'point', index };
  };

  const handleBendPointerDown = (e: React.PointerEvent, segIndex: number) => {
    if (!lane) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'bend', segIndex, startY: e.clientY, startBend: lane[segIndex].bend };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !selected || !lane) return;
    if (drag.kind === 'point') {
      const { t, v } = pointerNorm(e);
      updateLane(selected, movePoint(lane, drag.index, t, v));
    } else {
      const delta = (drag.startY - e.clientY) / 60;
      updateLane(selected, setBend(lane, drag.segIndex, drag.startBend + delta));
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const removeAt = (index: number) => {
    if (selected && lane) updateLane(selected, removePoint(lane, index));
  };

  const setBlocks = (delta: number) =>
    onChange({ ...loop, blocks: Math.min(LOOP_MAX_BLOCKS, Math.max(1, loop.blocks + delta)) });

  return (
    <div
      role="dialog"
      aria-label={`Looper ${deckLabel}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[760px] rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl shadow-black/60">
        <div className="mb-3 flex items-center gap-3">
          <span className="text-sm font-black tracking-widest text-cyan-400">
            LOOPER <span className="text-neutral-200">{deckLabel}</span>
          </span>

          <label className="ml-4 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
            Block
            <select
              value={loop.divider}
              onChange={(e) => onChange({ ...loop, divider: Number(e.target.value) })}
              aria-label="Block length in beats"
              className="rounded border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs text-neutral-300 focus:border-cyan-500 focus:outline-none"
            >
              {LOOP_DIVIDERS.map((d) => (
                <option key={d} value={d}>
                  {d < 1 ? `1/${1 / d}` : d} beat{d > 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setBlocks(-1)}
              aria-label="Remove block"
              className="w-6 rounded bg-neutral-800 py-1 text-xs font-bold text-neutral-300 hover:bg-neutral-700"
            >
              −
            </button>
            <span className="w-16 text-center text-[10px] uppercase tracking-wider text-neutral-400">
              {loop.blocks} block{loop.blocks > 1 ? 's' : ''}
            </span>
            <button
              type="button"
              onClick={() => setBlocks(1)}
              aria-label="Add block"
              className="w-6 rounded bg-neutral-800 py-1 text-xs font-bold text-neutral-300 hover:bg-neutral-700"
            >
              +
            </button>
          </div>

          <span className="text-[10px] text-neutral-600">
            loop = {loop.blocks} × {loop.divider < 1 ? `1/${1 / loop.divider}` : loop.divider} beats
          </span>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close looper"
            className="ml-auto rounded px-2 text-sm text-neutral-500 hover:text-neutral-200"
          >
            ✕
          </button>
        </div>

        <div className="flex gap-3">
          <div className="flex w-28 shrink-0 flex-col gap-0.5 overflow-y-auto" style={{ maxHeight: GRAPH_H }}>
            {LOOP_CONTROLS.map((control) => {
              const enabled = Boolean(loop.lanes[control.id]);
              const isSelected = selected === control.id;
              return (
                <div key={control.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => toggleControl(control.id)}
                    aria-label={`Automate ${control.label}`}
                    className="accent-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={() => enabled && setSelected(control.id)}
                    title={control.hint}
                    className={`flex-1 rounded px-1.5 py-0.5 text-left text-[10px] font-bold tracking-wider transition-colors ${
                      isSelected
                        ? 'bg-cyan-600 text-white'
                        : enabled
                          ? 'text-neutral-200 hover:bg-neutral-800'
                          : 'text-neutral-600'
                    }`}
                  >
                    {control.label}
                  </button>
                </div>
              );
            })}
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
            className="min-w-0 flex-1 cursor-crosshair rounded border border-neutral-800 bg-neutral-950"
            role="application"
            aria-label="Automation graph"
            onPointerDown={handleGraphPointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {/* block grid */}
            {Array.from({ length: loop.blocks + 1 }, (_, i) => (
              <line
                key={i}
                x1={toX(i / loop.blocks)}
                y1={PAD}
                x2={toX(i / loop.blocks)}
                y2={GRAPH_H - PAD}
                stroke={i === 0 || i === loop.blocks ? '#404040' : '#262626'}
                strokeWidth="1"
              />
            ))}
            {[0, 0.5, 1].map((v) => (
              <line
                key={v}
                x1={PAD}
                y1={toY(v)}
                x2={GRAPH_W - PAD}
                y2={toY(v)}
                stroke="#262626"
                strokeWidth="1"
              />
            ))}

            {/* ghost lanes for the other enabled controls */}
            {enabledIds
              .filter((id) => id !== selected)
              .map((id) => (
                <path key={id} d={lanePath(loop.lanes[id]!)} fill="none" stroke="#3f3f46" strokeWidth="1" />
              ))}

            {lane && (
              <>
                <path d={lanePath(lane)} fill="none" stroke="#22d3ee" strokeWidth="2" />
                {/* bend handles at segment midpoints */}
                {lane.slice(0, -1).map((p, i) => {
                  const next = lane[i + 1];
                  const mt = (p.t + next.t) / 2;
                  return (
                    <rect
                      key={`bend-${i}`}
                      data-testid={`bend-${i}`}
                      x={toX(mt) - 4}
                      y={toY(sampleLane(lane, mt)) - 4}
                      width="8"
                      height="8"
                      transform={`rotate(45 ${toX(mt)} ${toY(sampleLane(lane, mt))})`}
                      fill="#0e7490"
                      className="cursor-ns-resize"
                      onPointerDown={(e) => handleBendPointerDown(e, i)}
                    />
                  );
                })}
                {lane.map((p, i) => (
                  <circle
                    key={`pt-${i}`}
                    data-testid={`point-${i}`}
                    cx={toX(p.t)}
                    cy={toY(p.v)}
                    r="5"
                    fill="#22d3ee"
                    stroke="#0c4a6e"
                    className="cursor-move"
                    onPointerDown={(e) => handlePointPointerDown(e, i)}
                    onDoubleClick={() => removeAt(i)}
                  />
                ))}
              </>
            )}

            {!selected && (
              <text x={GRAPH_W / 2} y={GRAPH_H / 2} textAnchor="middle" fill="#525252" fontSize="11">
                enable a control on the left to draw its automation
              </text>
            )}
          </svg>
        </div>

        <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
          Click the graph to add a point · drag points to shape · double-click a point to remove ·
          drag a diamond to bend the curve. FADER multiplies the channel fader; every other lane
          overrides its knob while the loop plays.
        </p>
      </div>
    </div>
  );
}
