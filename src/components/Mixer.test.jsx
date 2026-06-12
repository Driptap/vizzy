import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Mixer } from './Mixer';

const defaultProps = () => ({
  opacities: [1, 0, 0, 0, 0.5, 0, 0, 0],
  muted: Array(8).fill(false),
  onChange: vi.fn(),
  onToggleMute: vi.fn(),
  crossfade: 0,
  onCrossfadeChange: vi.fn(),
  cueScene: 0,
  onCue: vi.fn(),
  midiLearn: false,
  armedControl: null,
  onArm: vi.fn(),
  controlMap: {},
});

const renderMixer = (overrides = {}) => {
  const props = { ...defaultProps(), ...overrides };
  render(<Mixer {...props} />);
  return props;
};

describe('Mixer', () => {
  it('renders 8 channel strips labelled A1-A4 and B1-B4', () => {
    renderMixer();
    ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'].forEach((label) => {
      expect(screen.getByRole('slider', { name: `${label} opacity` })).toBeInTheDocument();
    });
  });

  it('fader changes report the global slot index', () => {
    const { onChange } = renderMixer();
    fireEvent.change(screen.getByRole('slider', { name: 'B2 opacity' }), {
      target: { value: '0.8' },
    });
    expect(onChange).toHaveBeenCalledWith(5, 0.8);
  });

  it('mute buttons toggle the right slot and reflect state', () => {
    const muted = [...Array(8).fill(false)];
    muted[2] = true;
    const { onToggleMute } = renderMixer({ muted });

    expect(screen.getByRole('button', { name: 'Mute A3' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Mute B4' }));
    expect(onToggleMute).toHaveBeenCalledWith(7);
  });

  it('cue buttons select the scene and show the cued state', () => {
    const { onCue } = renderMixer({ cueScene: 0 });
    expect(screen.getByRole('button', { name: 'CUE A' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'CUE B' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'CUE B' }));
    expect(onCue).toHaveBeenCalledWith(1);
  });

  it('crossfader reports changes and snap-flips on double-click', () => {
    const { onCrossfadeChange } = renderMixer({ crossfade: 0.2 });
    const xfade = screen.getByRole('slider', { name: 'Scene crossfader' });

    fireEvent.change(xfade, { target: { value: '0.6' } });
    expect(onCrossfadeChange).toHaveBeenCalledWith(0.6);

    fireEvent.doubleClick(xfade);
    expect(onCrossfadeChange).toHaveBeenCalledWith(1); // 0.2 < 0.5 flips to B
  });

  it('double-click flips back to A from the B side', () => {
    const { onCrossfadeChange } = renderMixer({ crossfade: 0.9 });
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'Scene crossfader' }));
    expect(onCrossfadeChange).toHaveBeenCalledWith(0);
  });

  it('in MIDI learn mode, grabbing a control arms it', () => {
    const { onArm } = renderMixer({ midiLearn: true });
    fireEvent.pointerDown(screen.getByRole('slider', { name: 'A2 opacity' }));
    expect(onArm).toHaveBeenCalledWith('a_mix2');
    fireEvent.pointerDown(screen.getByRole('slider', { name: 'Scene crossfader' }));
    expect(onArm).toHaveBeenCalledWith('xfade');
  });

  it('outside MIDI learn mode, grabbing a control does not arm', () => {
    const { onArm } = renderMixer({ midiLearn: false });
    fireEvent.pointerDown(screen.getByRole('slider', { name: 'A2 opacity' }));
    expect(onArm).not.toHaveBeenCalled();
  });

  it('shows learned CC numbers from the control map', () => {
    renderMixer({ controlMap: { a_mix1: 21, xfade: 7 } });
    expect(screen.getByText('CC21')).toBeInTheDocument();
    expect(screen.getByText('XFADE · CC7')).toBeInTheDocument();
  });

  it('prompts for movement on the armed control', () => {
    renderMixer({ midiLearn: true, armedControl: 'xfade' });
    expect(screen.getByText('move a MIDI control…')).toBeInTheDocument();
  });
});
