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
  light: { brightness: 1, angle: 0 },
  onLightChange: vi.fn(),
  layer: 4,
  onLayerChange: vi.fn(),
  loop: { playing: false, blocks: 4, divider: 1, lanes: {} },
  onLoopChange: vi.fn(),
  sourceType: 'shader',
  fx: { tilt: 0, contrast: 1, hue: 0, sat: 1, band: 'level', amt: 1 },
  onFxChange: vi.fn(),
  filter: { kind: 'none', amount: 0.5, param2: 0.5 },
  onFilterChange: vi.fn(),
  aut: Object.fromEntries(
    ['scl', 'rot', 'tlt', 'flk', 'dst', 'skw'].map((k) => [k, { amt: 0, audio: false }]),
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

  it('the SCENE toggle switches what Generate produces', () => {
    const { onGenerate } = renderDeck({ prompt: 'crystal canyon' });
    fireEvent.click(screen.getByRole('button', { name: 'SCENE' }));
    expect(screen.getByRole('button', { name: 'SCENE' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onGenerate).toHaveBeenCalledWith(0, 'crystal canyon', 'scene');
    fireEvent.click(screen.getByRole('button', { name: 'GLSL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onGenerate).toHaveBeenLastCalledWith(0, 'crystal canyon', 'shader');
  });

  it('Generate sends the trimmed prompt', () => {
    const { onGenerate } = renderDeck({ prompt: '  neon waves  ', index: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onGenerate).toHaveBeenCalledWith(2, 'neon waves', 'shader');
  });

  it('Cmd/Ctrl+Enter in the prompt generates', () => {
    const { onGenerate } = renderDeck({ prompt: 'pulse' });
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true });
    expect(onGenerate).toHaveBeenCalledWith(0, 'pulse', 'shader');
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
    expect(onRegenerate).toHaveBeenCalledWith(0, 'broken thing', 'shader');

    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(onGenerate).toHaveBeenCalledWith(0, 'broken thing', 'shader');
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

  it('FILTER tab selects a filter and shows its generic controls', () => {
    const { onFilterChange } = renderDeck({
      filter: { kind: 'scanlines', amount: 0.5, param2: 0.5 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'FILTER' }));
    // scanlines exposes both generic knobs, labelled per filter
    expect(screen.getByRole('slider', { name: 'AMT' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'DENS' })).toBeInTheDocument();
    // picking a different filter reports the kind change
    fireEvent.change(screen.getByRole('combobox', { name: 'Deck 1 filter' }), {
      target: { value: 'pixelate' },
    });
    expect(onFilterChange).toHaveBeenCalledWith(0, 'kind', 'pixelate');
  });

  it('FILTER tab hides the controls when off', () => {
    renderDeck({ filter: { kind: 'none', amount: 0.5, param2: 0.5 } });
    fireEvent.click(screen.getByRole('button', { name: 'FILTER' }));
    expect(screen.queryByRole('slider', { name: 'AMT' })).not.toBeInTheDocument();
  });

  it('AUT knobs and audio-couple toggles report per-effect changes', () => {
    const { onAutChange } = renderDeck();
    fireEvent.click(screen.getByRole('button', { name: 'AUT' }));
    expect(screen.getByRole('slider', { name: 'ROT' })).toBeInTheDocument();

    expect(screen.getByRole('slider', { name: 'TLT' })).toBeInTheDocument();
    const couplers = screen.getAllByRole('button', { name: '♪' });
    expect(couplers).toHaveLength(6);
    fireEvent.click(couplers[1]); // rot
    expect(onAutChange).toHaveBeenCalledWith(0, 'rot', 'audio', true);
  });

  it('the layer switch shows the assignment and reports changes', () => {
    const { onLayerChange } = renderDeck({ index: 3, layer: 2 });
    expect(screen.getByRole('button', { name: 'Layer 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Layer 4' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Layer 1' }));
    expect(onLayerChange).toHaveBeenCalledWith(3, 1);
  });

  it('LIGHT tab appears only for lit decks and reports brightness/direction', () => {
    renderDeck();
    expect(screen.queryByRole('button', { name: 'LIGHT' })).not.toBeInTheDocument();

    renderDeck({ sourceType: 'scene', index: 1 });
    expect(screen.getByRole('button', { name: 'LIGHT' })).toBeInTheDocument();

    const { onLightChange } = renderDeck({ sourceType: 'model', index: 2 });
    fireEvent.click(screen.getAllByRole('button', { name: 'LIGHT' })[1]);
    fireEvent.wheel(screen.getByRole('slider', { name: 'BRT' }), { deltaY: -1 });
    expect(onLightChange).toHaveBeenCalledWith(2, 'brightness', 1 + 2 / 50);
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'DIR' }));
    expect(onLightChange).toHaveBeenCalledWith(2, 'angle', 0);
  });

  it('falls back to XFRM when a lit deck loses its LIGHT tab', () => {
    const props = { ...defaultProps(), sourceType: 'landscape' };
    const { rerender } = render(<DeckModule {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'LIGHT' }));
    rerender(<DeckModule {...props} sourceType="shader" />);
    expect(screen.getByRole('slider', { name: 'SCALE' })).toBeInTheDocument();
  });

  it('LOOP tab has play/pause and opens the editor modal', () => {
    const { onLoopChange } = renderDeck({ index: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'LOOP' }));

    fireEvent.click(screen.getByRole('button', { name: '▶' }));
    expect(onLoopChange).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ playing: true }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'EDIT' }));
    expect(screen.getByRole('dialog', { name: 'Looper A2' })).toBeInTheDocument();
  });

  it('the looper editor enables lanes seeded at the current knob value', () => {
    const { onLoopChange } = renderDeck({ scale: 3 }); // top of the 0.25..3 range
    fireEvent.click(screen.getByRole('button', { name: 'LOOP' }));
    fireEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Automate SCALE' }));
    expect(onLoopChange).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        lanes: {
          scale: [
            { t: 0, v: 1, bend: 0 },
            { t: 1, v: 1, bend: 0 },
          ],
        },
      }),
    );
  });

  it('the looper editor manages blocks within 1..8 and the tempo divider', () => {
    const { onLoopChange } = renderDeck({
      loop: { playing: false, blocks: 8, divider: 1, lanes: {} },
    });
    fireEvent.click(screen.getByRole('button', { name: 'LOOP' }));
    fireEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    expect(onLoopChange).toHaveBeenCalledWith(0, expect.objectContaining({ blocks: 8 })); // capped

    fireEvent.click(screen.getByRole('button', { name: 'Remove block' }));
    expect(onLoopChange).toHaveBeenCalledWith(0, expect.objectContaining({ blocks: 7 }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Block length in beats' }), {
      target: { value: '4' },
    });
    expect(onLoopChange).toHaveBeenCalledWith(0, expect.objectContaining({ divider: 4 }));
  });

  it('AUT tab is available on every deck (shader decks animate at the composite)', () => {
    renderDeck();
    expect(screen.getByRole('button', { name: 'AUT' })).toBeInTheDocument();
  });
});
