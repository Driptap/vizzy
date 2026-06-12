import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Knob } from './Knob';

const renderKnob = (props = {}) => {
  const onChange = vi.fn();
  render(
    <Knob
      label="SCALE"
      value={1}
      min={0.25}
      max={3}
      defaultValue={1}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange, knob: screen.getByRole('slider', { name: 'SCALE' }) };
};

describe('Knob', () => {
  it('exposes slider semantics', () => {
    const { knob } = renderKnob({ value: 2 });
    expect(knob).toHaveAttribute('aria-valuemin', '0.25');
    expect(knob).toHaveAttribute('aria-valuemax', '3');
    expect(knob).toHaveAttribute('aria-valuenow', '2');
  });

  it('shows the formatted value, falling back to 2 decimals', () => {
    renderKnob({ value: 1.5, format: (v) => `${v.toFixed(2)}x` });
    expect(screen.getByText('1.50x')).toBeInTheDocument();
    renderKnob({ label: 'OTHER', value: 0.5 });
    expect(screen.getByText('0.50')).toBeInTheDocument();
  });

  it('double-click resets to the default value', () => {
    const { onChange, knob } = renderKnob({ value: 2.7 });
    fireEvent.doubleClick(knob);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('scroll up nudges by 1/50 of the range, scroll down by the inverse', () => {
    const { onChange, knob } = renderKnob({ value: 1 });
    fireEvent.wheel(knob, { deltaY: -1 });
    expect(onChange).toHaveBeenLastCalledWith(1 + 2.75 / 50);
    fireEvent.wheel(knob, { deltaY: 1 });
    expect(onChange).toHaveBeenLastCalledWith(1 - 2.75 / 50);
  });

  it('dragging up increases the value (range / 150 per pixel)', () => {
    const { onChange, knob } = renderKnob({ value: 1 });
    knob.setPointerCapture = vi.fn();
    fireEvent.pointerDown(knob, { pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 50 }); // 150px up = full range
    expect(onChange).toHaveBeenLastCalledWith(3); // clamped at max
  });

  it('shift-drag is 4x finer', () => {
    const { onChange, knob } = renderKnob({ value: 1 });
    knob.setPointerCapture = vi.fn();
    fireEvent.pointerDown(knob, { pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 140, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(1 + (60 * 2.75) / 600);
  });

  it('drag clamps to min', () => {
    const { onChange, knob } = renderKnob({ value: 1 });
    knob.setPointerCapture = vi.fn();
    fireEvent.pointerDown(knob, { pointerId: 1, clientY: 0 });
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 1000 });
    expect(onChange).toHaveBeenLastCalledWith(0.25);
  });

  it('pointer moves without a drag in progress are ignored', () => {
    const { onChange, knob } = renderKnob();
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 50 });
    expect(onChange).not.toHaveBeenCalled();

    knob.setPointerCapture = vi.fn();
    fireEvent.pointerDown(knob, { pointerId: 1, clientY: 200 });
    fireEvent.pointerUp(knob, { pointerId: 1 });
    fireEvent.pointerMove(knob, { pointerId: 1, clientY: 50 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
