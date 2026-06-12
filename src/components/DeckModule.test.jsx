import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckModule } from './DeckModule';

const defaultProps = () => ({
  index: 0,
  sceneLetter: 'A',
  status: 'idle',
  error: null,
  prompt: '',
  onPromptChange: vi.fn(),
  scale: 1,
  onScaleChange: vi.fn(),
  size: { x: 1, y: 1 },
  onSizeChange: vi.fn(),
  pos: { x: 0, y: 0 },
  onPosChange: vi.fn(),
  sourceType: 'shader',
  fx: { tilt: 0, contrast: 1, hue: 0, sat: 1, band: 'level', amt: 1 },
  onFxChange: vi.fn(),
  aut: Object.fromEntries(
    ['scl', 'rot', 'flk', 'dst', 'skw'].map((k) => [k, { amt: 0, audio: false }]),
  ),
  onAutChange: vi.fn(),
  onGenerate: vi.fn(),
  onRegenerate: vi.fn(),
  onSave: vi.fn(),
  onReset: vi.fn(),
  previewRef: () => {},
});

const renderDeck = (overrides = {}) => {
  const props = { ...defaultProps(), ...overrides };
  render(<DeckModule {...props} />);
  return props;
};

const promptBox = () => screen.getByPlaceholderText(/neon plasma tunnel/);

describe('DeckModule generation', () => {
  it('Generate is disabled without a prompt', () => {
    renderDeck();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  it('typing reports prompt changes for this channel', () => {
    const { onPromptChange } = renderDeck();
    fireEvent.change(promptBox(), { target: { value: 'a fractal' } });
    expect(onPromptChange).toHaveBeenCalledWith(0, 'a fractal');
  });

  it('Generate sends the trimmed prompt', () => {
    const { onGenerate } = renderDeck({ prompt: '  neon waves  ', index: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onGenerate).toHaveBeenCalledWith(2, 'neon waves');
  });

  it('Cmd/Ctrl+Enter in the prompt generates', () => {
    const { onGenerate } = renderDeck({ prompt: 'pulse' });
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true });
    expect(onGenerate).toHaveBeenCalledWith(0, 'pulse');
    fireEvent.keyDown(promptBox(), { key: 'Enter' }); // plain Enter = newline
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('busy statuses disable Generate and show the status label', () => {
    renderDeck({ prompt: 'busy', status: 'generating' });
    const button = screen.getByRole('button', { name: 'Generating' });
    expect(button).toBeDisabled();
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true });
  });

  it('failed status swaps in Regenerate / Start fresh and shows the error', () => {
    const { onRegenerate, onGenerate } = renderDeck({
      prompt: 'broken thing',
      status: 'failed',
      error: 'ERROR: 0:13 syntax error',
    });
    expect(screen.getByText('ERROR: 0:13 syntax error')).toBeInTheDocument();
    expect(screen.getByText('Compile Failed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '⟲ Regenerate' }));
    expect(onRegenerate).toHaveBeenCalledWith(0, 'broken thing');

    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(onGenerate).toHaveBeenCalledWith(0, 'broken thing');
  });

  it('shows the scene letter with the channel number', () => {
    renderDeck({ sceneLetter: 'B', index: 3 });
    expect(screen.getByText('B4')).toBeInTheDocument();
  });

  it('RESET reports the channel index and sits next to SAVE', () => {
    const { onReset } = renderDeck({ index: 2 });
    const reset = screen.getByRole('button', { name: 'RESET' });
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledWith(2);
    // header order: RESET then SAVE
    const save = screen.getByRole('button', { name: 'SAVE' });
    expect(reset.nextElementSibling).toBe(save);
  });

  it('SAVE shows a confirmation tick', async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn().mockResolvedValue();
      renderDeck({ onSave });
      fireEvent.click(screen.getByRole('button', { name: 'SAVE' }));
      await vi.waitFor(() => expect(screen.getByRole('button', { name: '✓' })).toBeInTheDocument());
      expect(onSave).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DeckModule size controls', () => {
  it('W/H sliders report axis changes', () => {
    const { onSizeChange } = renderDeck({ index: 1 });
    fireEvent.change(screen.getByRole('slider', { name: 'Deck 2 output width' }), {
      target: { value: '0.5' },
    });
    expect(onSizeChange).toHaveBeenCalledWith(1, 'x', 0.5);
    fireEvent.change(screen.getByRole('slider', { name: 'Deck 2 output height' }), {
      target: { value: '0.25' },
    });
    expect(onSizeChange).toHaveBeenCalledWith(1, 'y', 0.25);
  });

  it('double-click resets an axis to 1', () => {
    const { onSizeChange } = renderDeck({ size: { x: 0.4, y: 1 } });
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'Deck 1 output width' }));
    expect(onSizeChange).toHaveBeenCalledWith(0, 'x', 1);
  });

  it('with aspect locked, moving one axis scales the other by the same factor', () => {
    const { onSizeChange } = renderDeck({ size: { x: 0.8, y: 0.6 } });
    fireEvent.click(screen.getByRole('button', { pressed: false, name: /Lock aspect ratio/ }));
    fireEvent.change(screen.getByRole('slider', { name: 'Deck 1 output width' }), {
      target: { value: '0.4' },
    });
    expect(onSizeChange).toHaveBeenCalledWith(0, 'x', 0.4);
    expect(onSizeChange).toHaveBeenCalledWith(0, 'y', 0.3); // halved with x
  });
});

describe('DeckModule tabs', () => {
  it('XFRM is the default tab with scale and tilt knobs', () => {
    renderDeck();
    expect(screen.getByRole('slider', { name: 'SCALE' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'TILT' })).toBeInTheDocument();
  });

  it('POS X/Y knobs appear for scene-based decks and report offsets', () => {
    renderDeck();
    expect(screen.queryByRole('slider', { name: 'POS X' })).not.toBeInTheDocument();

    const { onPosChange } = renderDeck({ sourceType: 'landscape', index: 1 });
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'POS X' })); // reset to 0
    expect(onPosChange).toHaveBeenCalledWith(1, 'x', 0);
    fireEvent.wheel(screen.getByRole('slider', { name: 'POS Y' }), { deltaY: -1 });
    expect(onPosChange).toHaveBeenCalledWith(1, 'y', 4 / 50); // 1/50 of the -2..2 range
  });

  it('AUDIO tab routes the band and amount', () => {
    const { onFxChange } = renderDeck();
    fireEvent.click(screen.getByRole('button', { name: 'AUDIO' }));
    fireEvent.click(screen.getByRole('button', { name: 'LO' }));
    expect(onFxChange).toHaveBeenCalledWith(0, 'band', 'low');
    expect(screen.getByRole('slider', { name: 'AMT' })).toBeInTheDocument();
  });

  it('COLOR tab exposes contrast, hue and saturation', () => {
    renderDeck();
    fireEvent.click(screen.getByRole('button', { name: 'COLOR' }));
    ['CON', 'HUE', 'SAT'].forEach((label) =>
      expect(screen.getByRole('slider', { name: label })).toBeInTheDocument(),
    );
  });

  it('AUT knobs and audio-couple toggles report per-effect changes', () => {
    const { onAutChange } = renderDeck();
    fireEvent.click(screen.getByRole('button', { name: 'AUT' }));
    expect(screen.getByRole('slider', { name: 'ROT' })).toBeInTheDocument();

    const couplers = screen.getAllByRole('button', { name: '♪' });
    expect(couplers).toHaveLength(5);
    fireEvent.click(couplers[1]); // rot
    expect(onAutChange).toHaveBeenCalledWith(0, 'rot', 'audio', true);
  });

  it('AUT tab is available on every deck (shader decks animate at the composite)', () => {
    renderDeck();
    expect(screen.getByRole('button', { name: 'AUT' })).toBeInTheDocument();
  });
});
