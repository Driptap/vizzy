import { useRef } from 'react';

const START = -135; // degrees from 12 o'clock
const SWEEP = 270;
const SIZE = 38;
const RADIUS = 14;

function angleToPoint(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

function arcPath(cx, cy, r, fromDeg, toDeg) {
  const [x1, y1] = angleToPoint(cx, cy, r, fromDeg);
  const [x2, y2] = angleToPoint(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * Rotary knob: drag vertically to change (Shift = fine), scroll to nudge,
 * double-click to reset. `bipolar` draws the value arc from 12 o'clock
 * instead of from the minimum — right for centred params like tilt/hue.
 */
export function Knob({
  label,
  value,
  min,
  max,
  defaultValue,
  onChange,
  format,
  bipolar = false,
  accent = '#22d3ee',
}) {
  const dragRef = useRef(null);
  const clamp = (v) => Math.min(max, Math.max(min, v));

  const frac = (value - min) / (max - min);
  const angle = START + frac * SWEEP;
  const c = SIZE / 2;
  const arcFrom = bipolar ? Math.min(0, angle) : START;
  const arcTo = bipolar ? Math.max(0, angle) : angle;
  const [px, py] = angleToPoint(c, c, RADIUS - 4, angle);

  return (
    <div className="flex w-12 select-none flex-col items-center gap-0.5">
      <svg
        width={SIZE}
        height={SIZE}
        className="cursor-ns-resize touch-none"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { startY: e.clientY, startValue: value };
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          const sensitivity = (max - min) / (e.shiftKey ? 600 : 150); // px per full range
          onChange(clamp(drag.startValue + (drag.startY - e.clientY) * sensitivity));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onDoubleClick={() => onChange(defaultValue)}
        onWheel={(e) => {
          onChange(clamp(value + ((e.deltaY < 0 ? 1 : -1) * (max - min)) / 50));
        }}
      >
        <path
          d={arcPath(c, c, RADIUS, START, START + SWEEP)}
          fill="none"
          stroke="#404040"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {arcTo - arcFrom > 0.5 && (
          <path
            d={arcPath(c, c, RADIUS, arcFrom, arcTo)}
            fill="none"
            stroke={accent}
            strokeWidth="3"
            strokeLinecap="round"
          />
        )}
        <circle cx={c} cy={c} r={RADIUS - 5} fill="#171717" stroke="#404040" strokeWidth="1" />
        <line x1={c} y1={c} x2={px} y2={py} stroke="#e5e5e5" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="font-mono text-[9px] leading-none text-neutral-300">
        {format ? format(value) : value.toFixed(2)}
      </span>
      <span className="text-[8px] font-bold leading-none tracking-wider text-neutral-500">
        {label}
      </span>
    </div>
  );
}
