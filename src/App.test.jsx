import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Integration test: App + real TopBar/Mixer/DeckModule/LibraryPanel/Tutorial,
// with the hardware/IO boundaries (GL renderer, audio, MIDI, Ollama, disk)
// mocked at the module seam.

vi.mock('./engine/NativeRenderEngine', () => {
  const engines = [];
  class NativeRenderEngine {
    constructor(viewCanvases, previewCanvases) {
      engines.push(this);
      this.setOpacity = vi.fn();
      this.setScale = vi.fn();
      this.setSize = vi.fn();
      this.setPosition = vi.fn();
      this.setLighting = vi.fn();
      this.setLayer = vi.fn();
      this.setLoop = vi.fn();
      this.setBpm = vi.fn();
      this.resetAllDecks = vi.fn();
      this.setChannelFx = vi.fn();
      this.setAudioRouting = vi.fn();
      this.setFilter = vi.fn();
      this.setAutomation = vi.fn();
      this.setCrossfade = vi.fn();
      this.setCueScene = vi.fn();
      this.setMasterCanvas = vi.fn();
      this.onMasterClosed = vi.fn();
      this.openMaster = vi.fn(async () => true);
      this.closeMaster = vi.fn(async () => false);
      this.onTextureShare = vi.fn();
      this.setTextureShare = vi.fn(async (on) => on);
      this.onGlow = vi.fn();
      this.setGlow = vi.fn(async (on) => on);
      this.stagePatch = vi.fn(async () => ({ ok: true }));
      this.stageSpriteFromPath = vi.fn(async () => ({ ok: true }));
      this.stageModelFromPath = vi.fn(async () => ({ ok: true }));
      this.stageLandscapeFromPath = vi.fn(async () => ({ ok: true }));
      this.stageSceneSpec = vi.fn(async () => ({ ok: true }));
      this.getPatch = vi.fn(() => ({ generator: 'plasma' }));
      this.getChannelSource = vi.fn(() => ({ type: 'shader', patch: { generator: 'plasma' } }));
      this.getPreviewDataURL = vi.fn(() => 'data:image/jpeg;preview');
      this.getSceneDataURL = vi.fn(() => 'data:image/jpeg;scene');
      this.dispose = vi.fn();
    }
  }
  return { NativeRenderEngine, CHANNELS: 4, __engines: engines };
});

vi.mock('./engine/NativeAudioEngine', () => {
  const audios = [];
  class NativeAudioEngine {
    constructor() {
      audios.push(this);
      this.active = false;
      this.start = vi.fn(async () => {});
      this.stop = vi.fn(async () => {});
      this.listDevices = vi.fn(async () => []);
      this.update = vi.fn(() => ({ low: 0, mid: 0, high: 0, level: 0 }));
    }
  }
  return { NativeAudioEngine, __audios: audios };
});

vi.mock('./engine/MidiEngine', () => {
  const midis = [];
  class MidiEngine {
    constructor(handlers) {
      midis.push(this);
      this.handlers = handlers;
      this.init = vi.fn(async () => {});
      this.arm = vi.fn();
      this.disarm = vi.fn();
      this.dispose = vi.fn();
      this.controlMap = vi.fn(() => ({}));
      this.inputCount = 0;
    }
  }
  return { MidiEngine, __midis: midis };
});

vi.mock('./llm/ollama', () => {
  const queues = [];
  class GenerationQueue {
    constructor(opts) {
      queues.push(this);
      this.opts = opts;
      this.enqueue = vi.fn();
    }
  }
  return {
    GenerationQueue,
    __queues: queues,
    DEFAULT_MODEL: 'qwen2.5-coder',
    resolveServer: vi.fn(async () => 'http://127.0.0.1:11434'),
    listInstalledModels: vi.fn(async () => ['qwen2.5-coder']),
  };
});

vi.mock('./lib/shaderLibrary', () => ({
  listShaders: vi.fn(async () => []),
  saveShader: vi.fn(async (data) => ({ id: 'shader-new', createdAt: 1, ...data })),
  saveDeck: vi.fn(async (data) => ({ id: 'deck-new', kind: 'deck', createdAt: 2, ...data })),
  saveModel: vi.fn(async () => ({ id: 'model-new', kind: 'model' })),
  getModelFilePath: vi.fn(async () => '/models/file.glb'),
  saveSprite: vi.fn(async () => ({ id: 'sprite-new', kind: 'sprite' })),
  getSpriteFilePath: vi.fn(async () => '/sprites/file.png'),
  filePathOf: vi.fn((file) => `/dropped/${file.name}`),
  renameShader: vi.fn(async (entry, name) => ({ ...entry, name })),
  updateEntry: vi.fn(async (entry) => entry),
  deleteEntry: vi.fn(async () => {}),
  hasSeededMarker: vi.fn(async () => true),
  writeSeededMarker: vi.fn(async () => {}),
}));

vi.mock('./lib/modelLoader', () => ({
  loadModelObject: vi.fn(async () => ({ kind: 'object3d' })),
}));

vi.mock('./lib/spriteLoader', () => ({
  loadSpriteTexture: vi.fn(async () => ({ texture: {}, aspect: 1 })),
  makeSpriteThumbnail: vi.fn(async () => 'data:thumb'),
}));

vi.mock('./lib/exampleSeed', () => ({
  EXAMPLE_DECK_NAME: 'Example Deck',
  dedupeExampleEntries: vi.fn(async (entries) => entries),
  seedExampleLibrary: vi.fn(async () => ({
    deck: { id: 'deck-seed', kind: 'deck', name: 'Example Deck', channels: [] },
    entries: [{ id: 'deck-seed', kind: 'deck', name: 'Example Deck', channels: [] }],
  })),
}));

vi.mock('./lib/session', () => ({
  saveSession: vi.fn(async () => {}),
  saveSessionSync: vi.fn(),
  loadSession: vi.fn(async () => null),
}));

// SetupScreen reaches window.require('electron') at import time
vi.mock('./components/SetupScreen', () => ({
  SetupScreen: ({ onSkip }) => (
    <div data-testid="setup-screen">
      <button type="button" onClick={onSkip}>skip setup</button>
    </div>
  ),
}));

import App from './App';
import { __engines } from './engine/NativeRenderEngine';
import { __audios } from './engine/NativeAudioEngine';
import { __midis } from './engine/MidiEngine';
import { __queues, resolveServer, listInstalledModels } from './llm/ollama';
import { hasSeededMarker, writeSeededMarker, listShaders, deleteEntry } from './lib/shaderLibrary';
import { seedExampleLibrary } from './lib/exampleSeed';
import { loadSession } from './lib/session';

const engine = () => __engines.at(-1);
const queue = () => __queues.at(-1);
const midi = () => __midis.at(-1);

const renderApp = async () => {
  const view = render(<App />);
  // wait for the async boot (LLM probe + library load) to settle
  await waitFor(() => expect(listShaders).toHaveBeenCalled());
  await waitFor(() => expect(resolveServer).toHaveBeenCalled());
  return view;
};

const deckPrompt = (i = 0) => screen.getAllByPlaceholderText(/neon plasma tunnel/)[i];

beforeEach(() => {
  vi.clearAllMocks();
  __engines.length = 0;
  __queues.length = 0;
  __midis.length = 0;
});

describe('boot', () => {
  it('renders the full rig: top bar, 8 mixer strips, 4 builder decks', async () => {
    await renderApp();
    expect(screen.getByText('VIZ')).toBeInTheDocument();
    ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'].forEach((label) =>
      expect(screen.getByRole('slider', { name: `${label} opacity` })).toBeInTheDocument(),
    );
    expect(screen.getAllByPlaceholderText(/neon plasma tunnel/)).toHaveLength(4);
    expect(screen.getByText('SCENE A')).toBeInTheDocument();
    expect(screen.getByText('SCENE B')).toBeInTheDocument();
  });

  it('skips the setup screen when the server has the chosen model', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByRole('button', { name: 'LLM' })).toBeInTheDocument());
    expect(screen.queryByTestId('setup-screen')).not.toBeInTheDocument();
  });

  it('opens the setup screen when no server answers', async () => {
    resolveServer.mockResolvedValueOnce(null);
    await renderApp();
    expect(await screen.findByTestId('setup-screen')).toBeInTheDocument();
  });

  it('opens the setup screen when the model is not installed', async () => {
    listInstalledModels.mockResolvedValueOnce(['some-other-model']);
    await renderApp();
    expect(await screen.findByTestId('setup-screen')).toBeInTheDocument();
  });

  it('the first state change syncs the full channel state to the engine', async () => {
    await renderApp();
    // any change triggers the single sync effect, which pushes everything
    fireEvent.change(screen.getByRole('slider', { name: 'Scene crossfader' }), {
      target: { value: '0.1' },
    });
    // channel 1 of each scene starts audible
    await waitFor(() => expect(engine().setOpacity).toHaveBeenCalledWith(0, 1));
    expect(engine().setOpacity).toHaveBeenCalledWith(4, 1);
    expect(engine().setOpacity).toHaveBeenCalledWith(1, 0);
    expect(engine().setCrossfade).toHaveBeenCalledWith(0.1);
  });
});

describe('first-run seeding', () => {
  it('seeds the example library exactly once', async () => {
    hasSeededMarker.mockResolvedValueOnce(false);
    await renderApp();
    await waitFor(() => expect(seedExampleLibrary).toHaveBeenCalled());
    expect(writeSeededMarker).toHaveBeenCalled();
  });

  it('does not re-seed when the marker file exists', async () => {
    await renderApp();
    await waitFor(() => expect(writeSeededMarker).toHaveBeenCalled()); // heals installs whose marker write failed
    expect(seedExampleLibrary).not.toHaveBeenCalled();
    expect(loadSession).toHaveBeenCalled();
  });
});

describe('shader generation', () => {
  it('enqueues the prompt for the cued slot and stages the parsed patch', async () => {
    await renderApp();
    fireEvent.change(deckPrompt(1), { target: { value: 'liquid chrome' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[1]);

    // patch mode sends the patch system prompt and the structured-output schema
    expect(queue().enqueue).toHaveBeenCalledWith(
      1,
      'liquid chrome',
      expect.any(Function),
      null,
      expect.stringContaining('"generator"'),
      expect.objectContaining({ required: ['generator'] }),
    );

    const onResponse = queue().enqueue.mock.calls[0][2];
    const raw = '{"generator": "noise-flow", "palette": {"preset": "vapor"}, "motion": {"speed": 1.2}}';
    await act(async () => onResponse(raw));

    expect(engine().stagePatch).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ generator: 'noise-flow', motion: { speed: 1.2 } }),
    );
    expect(await screen.findByText('Active')).toBeInTheDocument();
  });

  it('an unparseable response fails the deck with a regenerate path', async () => {
    await renderApp();
    fireEvent.change(deckPrompt(0), { target: { value: 'something' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);

    const onResponse = queue().enqueue.mock.calls[0][2];
    await act(async () => onResponse('Sorry, I can only answer questions about cooking.'));

    expect(engine().stagePatch).not.toHaveBeenCalled();
    expect(await screen.findByText('No JSON object found in the model response')).toBeInTheDocument();

    // Regenerate resubmits with the failed attempt attached as repair context
    fireEvent.click(screen.getByRole('button', { name: '⟲ Regenerate' }));
    expect(queue().enqueue).toHaveBeenLastCalledWith(
      0,
      'something',
      expect.any(Function),
      expect.objectContaining({
        error: 'No JSON object found in the model response',
      }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('a staging failure surfaces the engine error and repair context', async () => {
    await renderApp();
    engine().stagePatch.mockReturnValueOnce({ ok: false, error: 'render thread stopped' });

    fireEvent.change(deckPrompt(0), { target: { value: 'broken' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);
    const onResponse = queue().enqueue.mock.calls[0][2];
    await act(async () => onResponse('{"generator": "bars"}'));

    expect(await screen.findByText('render thread stopped')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '⟲ Regenerate' }));
    expect(queue().enqueue).toHaveBeenLastCalledWith(
      0,
      'broken',
      expect.any(Function),
      {
        code: '{"generator":"bars"}',
        error: 'render thread stopped',
      },
      expect.any(String),
      expect.any(Object),
    );
  });

  it('cueing scene B routes generation to slots 4-7', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'CUE B' }));
    expect(engine().setCueScene).toHaveBeenCalledWith(1);
    // builder cards relabel (mixer strip + deck header both say B1)
    expect(screen.getAllByText('B1').length).toBeGreaterThan(1);

    fireEvent.change(deckPrompt(0), { target: { value: 'for scene b' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);
    expect(queue().enqueue).toHaveBeenCalledWith(
      4,
      'for scene b',
      expect.any(Function),
      null,
      expect.any(String),
      expect.any(Object),
    );
  });
});

describe('mixer-to-engine sync', () => {
  it('fader moves reach the engine', async () => {
    await renderApp();
    fireEvent.change(screen.getByRole('slider', { name: 'B2 opacity' }), {
      target: { value: '0.8' },
    });
    await waitFor(() => expect(engine().setOpacity).toHaveBeenCalledWith(5, 0.8));
  });

  it('a muted channel outputs 0 while its fader position is preserved', async () => {
    await renderApp();
    engine().setOpacity.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Mute A1' }));
    await waitFor(() => expect(engine().setOpacity).toHaveBeenCalledWith(0, 0));

    engine().setOpacity.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Mute A1' }));
    await waitFor(() => expect(engine().setOpacity).toHaveBeenCalledWith(0, 1));
  });

  it('crossfade moves reach the engine', async () => {
    await renderApp();
    fireEvent.change(screen.getByRole('slider', { name: 'Scene crossfader' }), {
      target: { value: '0.65' },
    });
    await waitFor(() => expect(engine().setCrossfade).toHaveBeenCalledWith(0.65));
  });

  it('fx degrees are converted to radians for the engine', async () => {
    await renderApp();
    engine().setChannelFx.mockClear();
    const tilt = screen.getAllByRole('slider', { name: 'TILT' })[0];
    fireEvent.doubleClick(tilt); // reset triggers a sync pass
    await waitFor(() => expect(engine().setChannelFx).toHaveBeenCalled());
    const [slot, tiltRad, contrast, hueRad, sat] = engine().setChannelFx.mock.calls[0];
    expect(slot).toBe(0);
    expect(tiltRad).toBe(0);
    expect(contrast).toBe(1);
    expect(hueRad).toBe(0);
    expect(sat).toBe(1);
  });
});

describe('channel position', () => {
  it('POS knobs on a landscape deck reach the engine for the cued slot', async () => {
    const terrain = { id: 'model-9', kind: 'model', file: 't.stl', createdAt: 1 };
    listShaders.mockResolvedValueOnce([terrain]);
    loadSession.mockResolvedValueOnce({
      version: 1,
      crossfade: 0,
      cueScene: 0,
      slots: [{ source: { type: 'landscape', modelId: 'model-9' } }],
    });
    await renderApp();
    await waitFor(() => expect(engine().stageLandscapeFromPath).toHaveBeenCalled());

    engine().setPosition.mockClear();
    fireEvent.wheel(screen.getByRole('slider', { name: 'POS X' }), { deltaY: -1 });
    await waitFor(() => expect(engine().setPosition).toHaveBeenCalledWith(0, 4 / 50, 0));

    // RESET returns the offset to center
    engine().setPosition.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'RESET' })[0]);
    await waitFor(() => expect(engine().setPosition).toHaveBeenCalledWith(0, 0, 0));
  });
});

describe('layering', () => {
  it('the layer switch routes the cued slot to the engine and resets to base', async () => {
    await renderApp();
    expect(screen.getAllByRole('button', { name: 'Layer 1' })).toHaveLength(4);

    engine().setLayer.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'Layer 1' })[1]); // deck A2 to top
    await waitFor(() => expect(engine().setLayer).toHaveBeenCalledWith(1, 1));
    expect(screen.getAllByRole('button', { name: 'Layer 1' })[1]).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    engine().setLayer.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'RESET' })[1]);
    await waitFor(() => expect(engine().setLayer).toHaveBeenCalledWith(1, 4));
  });

  it('cueing scene B routes layer changes to slots 4-7', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'CUE B' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Layer 2' })[2]); // deck B3
    await waitFor(() => expect(engine().setLayer).toHaveBeenCalledWith(6, 2));
  });
});

describe('looper', () => {
  it('BPM edits and loop play state reach the engine for the cued slot', async () => {
    await renderApp();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tempo in BPM' }), {
      target: { value: '140' },
    });
    await waitFor(() => expect(engine().setBpm).toHaveBeenCalledWith(140));

    fireEvent.click(screen.getAllByRole('button', { name: 'LOOP' })[2]); // deck A3's tab
    engine().setLoop.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '▶' }));
    await waitFor(() =>
      expect(engine().setLoop).toHaveBeenCalledWith(2, expect.objectContaining({ playing: true })),
    );
  });

  it('BPM is clamped to a sane musical range', async () => {
    await renderApp();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tempo in BPM' }), {
      target: { value: '9999' },
    });
    await waitFor(() => expect(engine().setBpm).toHaveBeenCalledWith(220));
  });
});

describe('channel lighting', () => {
  it('LIGHT knobs reach the engine in radians and reset to defaults', async () => {
    const model = { id: 'model-5', kind: 'model', file: 'm.glb', createdAt: 1 };
    listShaders.mockResolvedValueOnce([model]);
    loadSession.mockResolvedValueOnce({
      version: 1,
      crossfade: 0,
      cueScene: 0,
      slots: [{ source: { type: 'model', modelId: 'model-5' } }],
    });
    await renderApp();
    await waitFor(() => expect(engine().stageModelFromPath).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole('button', { name: 'LIGHT' })[0]);
    engine().setLighting.mockClear();
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'DIR' })); // reset-to-0 still syncs
    await waitFor(() => expect(engine().setLighting).toHaveBeenCalledWith(0, 1, 0));

    fireEvent.wheel(screen.getByRole('slider', { name: 'DIR' }), { deltaY: -1 });
    await waitFor(() =>
      expect(engine().setLighting).toHaveBeenCalledWith(
        0,
        1,
        ((360 / 50) * Math.PI) / 180, // one wheel notch of the ±180° range, in radians
      ),
    );

    engine().setLighting.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'RESET' })[0]);
    await waitFor(() => expect(engine().setLighting).toHaveBeenCalledWith(0, 1, 0));
  });
});

describe('channel reset', () => {
  it('resets the cued channel knobs to defaults but leaves the rest alone', async () => {
    await renderApp();
    // detune channel 2 of scene A (slot 1)
    const tilt = screen.getAllByRole('slider', { name: 'TILT' })[1];
    fireEvent.wheel(tilt, { deltaY: -1 });
    const scale = screen.getAllByRole('slider', { name: 'SCALE' })[1];
    fireEvent.wheel(scale, { deltaY: -1 });
    await waitFor(() => expect(engine().setScale).toHaveBeenCalledWith(1, expect.not.closeTo(1)));

    engine().setScale.mockClear();
    engine().setChannelFx.mockClear();
    engine().setSize.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'RESET' })[1]);

    await waitFor(() => expect(engine().setScale).toHaveBeenCalledWith(1, 1));
    expect(engine().setSize).toHaveBeenCalledWith(1, 1, 1);
    expect(engine().setChannelFx).toHaveBeenCalledWith(1, 0, 1, 0, 1);
  });

  it('reset on scene B targets slots 4-7', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'CUE B' }));
    const scale = screen.getAllByRole('slider', { name: 'SCALE' })[0];
    fireEvent.wheel(scale, { deltaY: -1 });

    engine().setScale.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'RESET' })[0]);
    await waitFor(() => expect(engine().setScale).toHaveBeenCalledWith(4, 1));
  });

  it('reset leaves the prompt and the staged source alone', async () => {
    await renderApp();
    fireEvent.change(deckPrompt(0), { target: { value: 'keep me' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'RESET' })[0]);
    expect(deckPrompt(0)).toHaveValue('keep me');
    expect(engine().stagePatch).not.toHaveBeenCalled();
  });
});

describe('MIDI control routing', () => {
  it('maps bound controls onto crossfade and channel faders', async () => {
    await renderApp();
    act(() => midi().handlers.onControlValue('xfade', 0.42));
    await waitFor(() => expect(engine().setCrossfade).toHaveBeenCalledWith(0.42));

    act(() => midi().handlers.onControlValue('b_mix3', 0.9));
    await waitFor(() => expect(engine().setOpacity).toHaveBeenCalledWith(6, 0.9));

    act(() => midi().handlers.onControlValue('a_mix1', 0.1));
    await waitFor(() => expect(engine().setOpacity).toHaveBeenCalledWith(0, 0.1));
  });

  it('MIDI learn arms a control via the mixer', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'MIDI Learn' }));
    fireEvent.pointerDown(screen.getByRole('slider', { name: 'A2 opacity' }));
    expect(midi().arm).toHaveBeenCalledWith('a_mix2');
  });
});

describe('session restore', () => {
  it('re-stages saved slots and restores the mixer state', async () => {
    loadSession.mockResolvedValueOnce({
      version: 1,
      crossfade: 0.5,
      cueScene: 0,
      slots: [
        {
          source: { type: 'shader', patch: { generator: 'tunnel', motion: { speed: 1.5 } } },
          prompt: 'restored prompt',
          opacity: 0.4,
          muted: false,
          scale: 1.5,
          size: { x: 0.9, y: 0.8 },
        },
      ],
    });
    await renderApp();

    await waitFor(() =>
      expect(engine().stagePatch).toHaveBeenCalledWith(0, {
        generator: 'tunnel',
        motion: { speed: 1.5 },
      }),
    );
    expect(deckPrompt(0)).toHaveValue('restored prompt');
    expect(screen.getByRole('slider', { name: 'Scene crossfader' })).toHaveValue('0.5');
    expect(screen.getByRole('slider', { name: 'A1 opacity' })).toHaveValue('0.4');
    await waitFor(() => expect(engine().setScale).toHaveBeenCalledWith(0, 1.5));
  });
});

describe('procedural scene generation', () => {
  const SCENE_JSON =
    '{"kind":"tunnel","surface":"sin(a*6)+fract(z*0.5)","amplitude":2,"palette":["#1a0533","#05ffa1","#000000"]}';

  it('SCENE mode sends the scene system prompt and stages the parsed spec', async () => {
    await renderApp();
    fireEvent.change(deckPrompt(0), { target: { value: 'neon wormhole' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'SCENE' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);

    const [slot, prompt, handler, repair, system] = queue().enqueue.mock.calls[0];
    expect(slot).toBe(0);
    expect(prompt).toBe('neon wormhole');
    expect(repair).toBeNull();
    expect(system).toContain('ONLY a single JSON object');

    await act(async () => handler(SCENE_JSON));
    expect(engine().stageSceneSpec).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ kind: 'tunnel', amplitude: 2 }),
    );
    expect(await screen.findByText('Active')).toBeInTheDocument();
  });

  it('an unparseable scene response fails the deck with the specific error', async () => {
    await renderApp();
    fireEvent.change(deckPrompt(0), { target: { value: 'something' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'SCENE' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);

    const handler = queue().enqueue.mock.calls[0][2];
    await act(async () => handler('{"kind":"terrain","surface":"alert(1)"}'));
    expect(engine().stageSceneSpec).not.toHaveBeenCalled();
    expect(await screen.findByText(/Bad surface expression/)).toBeInTheDocument();
  });

  it('a session scene source restores through stageSceneSpec', async () => {
    loadSession.mockResolvedValueOnce({
      version: 1,
      crossfade: 0,
      cueScene: 0,
      slots: [
        {
          source: {
            type: 'scene',
            spec: { kind: 'terrain', surface: 'sin(x)', amplitude: 2, palette: ['#111111', '#222222', '#333333'] },
          },
        },
      ],
    });
    await renderApp();
    await waitFor(() =>
      expect(engine().stageSceneSpec).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ kind: 'terrain', surface: 'sin(x)' }),
      ),
    );
  });
});

describe('landscape restore', () => {
  it('a saved landscape slot restores through stageLandscapeFromPath, not stageModelFromPath', async () => {
    const terrain = { id: 'model-9', kind: 'model', file: 't.stl', createdAt: 1 };
    listShaders.mockResolvedValueOnce([terrain]);
    loadSession.mockResolvedValueOnce({
      version: 1,
      crossfade: 0,
      cueScene: 0,
      slots: [{ source: { type: 'landscape', modelId: 'model-9' }, opacity: 1 }],
    });
    await renderApp();

    await waitFor(() =>
      expect(engine().stageLandscapeFromPath).toHaveBeenCalledWith(0, '/models/file.glb', 'model-9'),
    );
    expect(engine().stageModelFromPath).not.toHaveBeenCalled();
  });
});

describe('reset rig', () => {
  it('confirmed reset blanks the decks and mixer but never touches the library', async () => {
    await renderApp();
    // dirty the rig: a prompt, a staged shader, a hot fader, a moved crossfader
    fireEvent.change(deckPrompt(0), { target: { value: 'about to vanish' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);
    await act(async () => queue().enqueue.mock.calls[0][2]('{"generator": "plasma"}'));
    fireEvent.change(screen.getByRole('slider', { name: 'B3 opacity' }), {
      target: { value: '0.9' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Scene crossfader' }), {
      target: { value: '0.7' },
    });
    expect(await screen.findByText('Active')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Rig' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sure? Click again' }));

    expect(engine().resetAllDecks).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(deckPrompt(0)).toHaveValue(''));
    expect(screen.getByRole('slider', { name: 'B3 opacity' })).toHaveValue('0');
    expect(screen.getByRole('slider', { name: 'A1 opacity' })).toHaveValue('1'); // boot state
    expect(screen.getByRole('slider', { name: 'Scene crossfader' })).toHaveValue('0');
    expect(screen.queryByText('Active')).not.toBeInTheDocument(); // statuses back to idle
    // library operations were never invoked
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it('a single unconfirmed click does nothing', async () => {
    await renderApp();
    fireEvent.change(deckPrompt(0), { target: { value: 'still here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Rig' }));
    expect(engine().resetAllDecks).not.toHaveBeenCalled();
    expect(deckPrompt(0)).toHaveValue('still here');
  });
});

describe('teardown', () => {
  it('unmount disposes the engines', async () => {
    const { unmount } = await renderApp();
    unmount();
    expect(engine().dispose).toHaveBeenCalled();
    expect(midi().dispose).toHaveBeenCalled();
    expect(__audios[__audios.length - 1].stop).toHaveBeenCalled();
  });
});
