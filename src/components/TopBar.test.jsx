import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TopBar } from './TopBar';
import { MODEL_CATALOG } from '../llm/models';

const defaultProps = () => ({
  libraryOpen: false,
  onToggleLibrary: vi.fn(),
  masterOpen: false,
  onToggleMaster: vi.fn(),
  audioActive: false,
  audioDevices: [],
  selectedDevice: '',
  onSelectDevice: vi.fn(),
  onToggleAudio: vi.fn(),
  model: 'qwen2.5-coder',
  onModelChange: vi.fn(),
  installedModels: ['qwen2.5-coder'],
  llmReady: true,
  onOpenSetup: vi.fn(),
  midiLearn: false,
  onToggleMidiLearn: vi.fn(),
  midiInputs: 0,
  onOpenTutorial: vi.fn(),
  onResetRig: vi.fn(),
  bpm: 120,
  onBpmChange: vi.fn(),
});

const renderTopBar = (overrides = {}) => {
  const props = { ...defaultProps(), ...overrides };
  render(<TopBar {...props} />);
  return props;
};

describe('TopBar', () => {
  it('toggles the library and master output', () => {
    const { onToggleLibrary, onToggleMaster } = renderTopBar();
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    expect(onToggleLibrary).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Master Out' }));
    expect(onToggleMaster).toHaveBeenCalled();
  });

  it('reflects master/audio/midi state in the button labels', () => {
    renderTopBar({ masterOpen: true, audioActive: true, midiLearn: true, midiInputs: 2 });
    expect(screen.getByRole('button', { name: '● Master Out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '● Live' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MIDI Learn: ON' })).toBeInTheDocument();
    expect(screen.getByText('2 MIDI in')).toBeInTheDocument();
  });

  it('lists audio devices and falls back to a generated label', () => {
    const { onSelectDevice } = renderTopBar({
      audioDevices: [
        { deviceId: 'abc123456', label: 'USB Interface' },
        { deviceId: 'def987654', label: '' },
      ],
    });
    expect(screen.getByRole('option', { name: 'USB Interface' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Input def987' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('option', { name: 'USB Interface' }).closest('select'), {
      target: { value: 'abc123456' },
    });
    expect(onSelectDevice).toHaveBeenCalledWith('abc123456');
  });

  it('LLM badge reflects setup state and opens setup', () => {
    const ready = renderTopBar({ llmReady: true });
    fireEvent.click(screen.getByRole('button', { name: '● LLM' }));
    expect(ready.onOpenSetup).toHaveBeenCalled();
  });

  it('shows Setup LLM when not ready', () => {
    renderTopBar({ llmReady: false });
    expect(screen.getByRole('button', { name: 'Setup LLM' })).toBeInTheDocument();
  });

  it('offers the whole model catalog and flags missing downloads', () => {
    renderTopBar({ installedModels: ['qwen2.5-coder'] });
    MODEL_CATALOG.forEach((m) => {
      const option = screen.getByRole('option', { name: new RegExp(m.name) });
      if (m.tag === 'qwen2.5-coder') {
        expect(option.textContent).not.toContain('(not downloaded)');
      } else {
        expect(option.textContent).toContain('(not downloaded)');
      }
    });
  });

  it('selecting a catalog model reports the tag', () => {
    const { onModelChange } = renderTopBar();
    const select = screen.getByRole('option', { name: /Qwen2.5 Coder 14B/ }).closest('select');
    fireEvent.change(select, { target: { value: 'qwen2.5-coder:14b' } });
    expect(onModelChange).toHaveBeenCalledWith('qwen2.5-coder:14b');
  });

  it('Custom… reveals a free-form tag input', () => {
    const { onModelChange } = renderTopBar();
    expect(screen.queryByPlaceholderText('any ollama tag')).not.toBeInTheDocument();

    const select = screen.getByRole('option', { name: 'Custom…' }).closest('select');
    fireEvent.change(select, { target: { value: '__custom__' } });
    const input = screen.getByPlaceholderText('any ollama tag');
    fireEvent.change(input, { target: { value: 'my-fine-tune' } });
    expect(onModelChange).toHaveBeenCalledWith('my-fine-tune');
  });

  it('starts in custom mode when the model is not in the catalog', () => {
    renderTopBar({ model: 'some-local-model' });
    expect(screen.getByPlaceholderText('any ollama tag')).toHaveValue('some-local-model');
  });

  it('Reset Rig requires a confirming second click', () => {
    const { onResetRig } = renderTopBar();
    const button = screen.getByRole('button', { name: 'Reset Rig' });
    fireEvent.click(button);
    expect(onResetRig).not.toHaveBeenCalled(); // armed, not fired
    fireEvent.click(screen.getByRole('button', { name: 'Sure? Click again' }));
    expect(onResetRig).toHaveBeenCalledTimes(1);
    // back to the resting label after firing
    expect(screen.getByRole('button', { name: 'Reset Rig' })).toBeInTheDocument();
  });

  it('an armed reset disarms itself after 3 seconds', () => {
    vi.useFakeTimers();
    try {
      const { onResetRig } = renderTopBar();
      fireEvent.click(screen.getByRole('button', { name: 'Reset Rig' }));
      act(() => vi.advanceTimersByTime(3100));
      // the next click only re-arms — the timeout cancelled the confirmation
      fireEvent.click(screen.getByRole('button', { name: 'Reset Rig' }));
      expect(onResetRig).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the global tempo and reports changes', () => {
    const { onBpmChange } = renderTopBar({ bpm: 128 });
    const input = screen.getByRole('spinbutton', { name: 'Tempo in BPM' });
    expect(input).toHaveValue(128);
    fireEvent.change(input, { target: { value: '140' } });
    expect(onBpmChange).toHaveBeenCalledWith(140);
  });

  it('opens the tutorial', () => {
    const { onOpenTutorial } = renderTopBar();
    fireEvent.click(screen.getByRole('button', { name: 'Open tutorial' }));
    expect(onOpenTutorial).toHaveBeenCalled();
  });
});
