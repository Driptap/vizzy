import { useCallback, useEffect, useRef, useState } from 'react';
import { RenderEngine, CHANNELS } from './engine/RenderEngine';
import { AudioEngine } from './engine/AudioEngine';
import { MidiEngine } from './engine/MidiEngine';
import { GenerationQueue, DEFAULT_MODEL } from './llm/ollama';
import { extractShaderCode } from './llm/parser';
import { TopBar } from './components/TopBar';
import { DeckModule } from './components/DeckModule';
import { Mixer } from './components/Mixer';
import { LibraryPanel } from './components/LibraryPanel';
import {
  listShaders,
  saveShader,
  saveDeck,
  renameShader,
  deleteShader,
} from './lib/shaderLibrary';

const SLOTS = CHANNELS * 2; // scene A: 0-3, scene B: 4-7
const SCENE_LETTERS = ['A', 'B'];
// channel 1 of each scene starts audible so neither side of the fader is black
const INITIAL_OPACITIES = [1, 0, 0, 0, 1, 0, 0, 0];

// per-channel fx: tilt/hue in degrees (engine takes radians), band routes
// which global band drives the deck's u_audio_level, amt = response multiplier
const DEFAULT_FX = { tilt: 0, contrast: 1, hue: 0, sat: 1, band: 'level', amt: 1 };

export default function App() {
  const sceneACanvasRef = useRef(null);
  const sceneBCanvasRef = useRef(null);
  const masterWindowRef = useRef(null);
  const previewRefs = useRef([]);
  const engineRef = useRef(null);
  const audioRef = useRef(null);
  const midiRef = useRef(null);
  const queueRef = useRef(null);
  // fall back to the pre-rebrand (promptvj.*) keys so settings survive
  const modelRef = useRef(
    localStorage.getItem('vizzy.model') || localStorage.getItem('promptvj.model') || DEFAULT_MODEL,
  );

  const [decks, setDecks] = useState(() =>
    Array.from({ length: SLOTS }, () => ({ status: 'idle', error: null })),
  );
  const [prompts, setPrompts] = useState(() => Array(SLOTS).fill(''));
  const [opacities, setOpacities] = useState(INITIAL_OPACITIES);
  const [muted, setMuted] = useState(() => Array(SLOTS).fill(false));
  const [scales, setScales] = useState(() => Array(SLOTS).fill(1));
  const [sizes, setSizes] = useState(() =>
    Array.from({ length: SLOTS }, () => ({ x: 1, y: 1 })),
  );
  const [fx, setFx] = useState(() => Array.from({ length: SLOTS }, () => ({ ...DEFAULT_FX })));
  const [crossfade, setCrossfade] = useState(0);
  const [cueScene, setCueScene] = useState(0);
  const [library, setLibrary] = useState([]);
  const [libraryOpen, setLibraryOpen] = useState(
    () =>
      (localStorage.getItem('vizzy.libraryOpen') ??
        localStorage.getItem('promptvj.libraryOpen')) === '1',
  );
  const [audioActive, setAudioActive] = useState(false);
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [model, setModel] = useState(modelRef.current);
  const [midiLearn, setMidiLearn] = useState(false);
  const [armedControl, setArmedControl] = useState(null);
  const [controlMap, setControlMap] = useState({});
  const [midiInputs, setMidiInputs] = useState(0);
  const [masterOpen, setMasterOpen] = useState(false);

  const setDeckState = useCallback((slot, status, error = null) => {
    setDecks((prev) => prev.map((d, i) => (i === slot ? { status, error } : d)));
  }, []);

  const applyOpacity = useCallback((slot, value) => {
    setOpacities((prev) => prev.map((v, i) => (i === slot ? value : v)));
  }, []);

  const toggleMute = useCallback((slot) => {
    setMuted((prev) => prev.map((m, i) => (i === slot ? !m : m)));
  }, []);

  const applyScale = useCallback((slot, value) => {
    setScales((prev) => prev.map((v, i) => (i === slot ? value : v)));
  }, []);

  const applySize = useCallback((slot, axis, value) => {
    setSizes((prev) => prev.map((s, i) => (i === slot ? { ...s, [axis]: value } : s)));
  }, []);

  const applyCrossfade = useCallback((value) => {
    setCrossfade(value);
  }, []);

  const applyFx = useCallback((slot, key, value) => {
    setFx((prev) => prev.map((f, i) => (i === slot ? { ...f, [key]: value } : f)));
  }, []);

  // Single sync point for the composite uniforms: a muted channel outputs 0
  // while its fader position is preserved for unmute.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    opacities.forEach((value, i) => engine.setOpacity(i, muted[i] ? 0 : value));
    scales.forEach((value, i) => engine.setScale(i, value));
    sizes.forEach((size, i) => engine.setSize(i, size.x, size.y));
    fx.forEach((f, i) => {
      engine.setChannelFx(i, (f.tilt * Math.PI) / 180, f.contrast, (f.hue * Math.PI) / 180, f.sat);
      engine.setAudioRouting(i, f.band, f.amt);
    });
    engine.setCrossfade(crossfade);
  }, [opacities, muted, scales, sizes, fx, crossfade]);

  useEffect(() => {
    engineRef.current?.setCueScene(cueScene);
  }, [cueScene]);

  useEffect(() => {
    const audio = new AudioEngine();
    audioRef.current = audio;

    const engine = new RenderEngine(
      { a: sceneACanvasRef.current, b: sceneBCanvasRef.current },
      previewRefs.current,
      audio,
    );
    engineRef.current = engine;

    queueRef.current = new GenerationQueue({
      getModel: () => modelRef.current,
      onStatus: setDeckState,
    });

    const midi = new MidiEngine({
      onControlValue: (controlId, value) => {
        if (controlId === 'xfade') {
          applyCrossfade(value);
          return;
        }
        const match = controlId.match(/^([ab])_mix([1-4])$/);
        if (match) {
          const slot = (match[1] === 'b' ? CHANNELS : 0) + Number(match[2]) - 1;
          applyOpacity(slot, value);
        }
      },
      onLearned: () => {
        setArmedControl(null);
        setControlMap(midi.controlMap());
      },
    });
    midiRef.current = midi;
    setControlMap(midi.controlMap());
    midi
      .init()
      .then(() => setMidiInputs(midi.inputCount))
      .catch((err) => console.warn('[Vizzy] MIDI unavailable:', err));

    return () => {
      engine.dispose();
      audio.stop();
      midi.dispose();
      const popup = masterWindowRef.current;
      if (popup && !popup.closed) popup.close();
    };
  }, [setDeckState, applyOpacity, applyCrossfade]);

  // Master out lives in its own window: window.open keeps it in this renderer
  // process, so the engine blits straight into its canvas each frame.
  const handleToggleMaster = useCallback(() => {
    const existing = masterWindowRef.current;
    if (existing && !existing.closed) {
      existing.close(); // pagehide handler below does the detach
      return;
    }

    const popup = window.open('', 'vizzy-master', 'width=1280,height=720');
    if (!popup) return;
    masterWindowRef.current = popup;

    const doc = popup.document;
    doc.title = 'Vizzy — Master Out';
    doc.body.innerHTML = '';
    doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
    const canvas = doc.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100vw;height:100vh;';
    canvas.title = 'Double-click for fullscreen';
    doc.body.appendChild(canvas);
    canvas.addEventListener('dblclick', () => {
      if (doc.fullscreenElement) doc.exitFullscreen();
      else canvas.requestFullscreen().catch(() => {});
    });

    popup.addEventListener('pagehide', () => {
      if (masterWindowRef.current === popup) {
        masterWindowRef.current = null;
        engineRef.current?.setMasterCanvas(null);
        setMasterOpen(false);
      }
    });

    engineRef.current?.setMasterCanvas(canvas);
    setMasterOpen(true);
  }, []);

  useEffect(() => {
    listShaders()
      .then(setLibrary)
      .catch((err) => console.warn('[Vizzy] Could not load shader library:', err));
  }, []);

  const handleToggleLibrary = useCallback(() => {
    setLibraryOpen((prev) => {
      localStorage.setItem('vizzy.libraryOpen', prev ? '0' : '1');
      return !prev;
    });
  }, []);

  // ---- builder actions: channel (0-3) -> slot via the cued scene ----

  const handlePromptChange = useCallback(
    (channel, text) => {
      const slot = cueScene * CHANNELS + channel;
      setPrompts((prev) => prev.map((p, i) => (i === slot ? text : p)));
    },
    [cueScene],
  );

  const handleGenerate = useCallback(
    (channel, prompt) => {
      const slot = cueScene * CHANNELS + channel;
      queueRef.current?.enqueue(slot, prompt, (raw) => {
        const code = extractShaderCode(raw);
        if (!code) {
          setDeckState(slot, 'failed', 'No GLSL main() block found in the model response');
          return;
        }
        setDeckState(slot, 'compiling');
        const result = engineRef.current.stageShader(slot, code);
        if (result.ok) setDeckState(slot, 'active');
        else setDeckState(slot, 'failed', result.error);
      });
    },
    [setDeckState, cueScene],
  );

  const handleSaveDeck = useCallback(
    async (channel) => {
      const engine = engineRef.current;
      if (!engine) return;
      const slot = cueScene * CHANNELS + channel;
      try {
        const entry = await saveShader({
          code: engine.getShaderBody(slot),
          screenshot: engine.getPreviewDataURL(channel),
        });
        setLibrary((prev) => [entry, ...prev]);
      } catch (err) {
        console.error('[Vizzy] Saving shader failed:', err);
      }
    },
    [cueScene],
  );

  const handleAddToChannel = useCallback(
    (entry, channel) => {
      const slot = cueScene * CHANNELS + channel;
      const result = engineRef.current?.stageShader(slot, entry.code);
      if (result?.ok) setDeckState(slot, 'active');
      else setDeckState(slot, 'failed', result?.error || 'Compile failed');
    },
    [setDeckState, cueScene],
  );

  // Save the cued scene as a deck preset. Channels whose shader code isn't in
  // the library yet get saved as (unnamed) shader entries first; the deck
  // references shaders by id and carries each channel's full config.
  const handleSaveDeckScene = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const scene = cueScene;
    try {
      const newShaders = [];
      const channels = [];
      for (let ch = 0; ch < CHANNELS; ch += 1) {
        const slot = scene * CHANNELS + ch;
        const code = engine.getShaderBody(slot);
        let shaderEntry =
          library.find((e) => e.kind !== 'deck' && e.code === code) ||
          newShaders.find((e) => e.code === code);
        if (!shaderEntry) {
          // eslint-disable-next-line no-await-in-loop
          shaderEntry = await saveShader({ code, screenshot: engine.getPreviewDataURL(ch) });
          newShaders.push(shaderEntry);
        }
        channels.push({
          shaderId: shaderEntry.id,
          prompt: prompts[slot],
          opacity: opacities[slot],
          muted: muted[slot],
          scale: scales[slot],
          size: { ...sizes[slot] },
          fx: { ...fx[slot] },
        });
      }
      const deckEntry = await saveDeck({ channels, screenshot: engine.getSceneDataURL(scene) });
      setLibrary((prev) => [deckEntry, ...newShaders, ...prev]);
    } catch (err) {
      console.error('[Vizzy] Saving deck preset failed:', err);
    }
  }, [cueScene, library, prompts, opacities, muted, scales, sizes, fx]);

  // Load a deck preset into scene A or B: stage all 4 shaders and restore
  // each channel's config; the sync effect pushes it to the engine.
  const handleAssignDeck = useCallback(
    (entry, scene) => {
      const engine = engineRef.current;
      if (!engine) return;
      const shaderById = new Map(
        library.filter((e) => e.kind !== 'deck').map((e) => [e.id, e]),
      );
      entry.channels.forEach((cfg, ch) => {
        const slot = scene * CHANNELS + ch;
        const shader = shaderById.get(cfg.shaderId);
        if (!shader) {
          setDeckState(slot, 'failed', 'Saved shader is missing from the library');
          return;
        }
        const result = engine.stageShader(slot, shader.code);
        if (result?.ok) setDeckState(slot, 'active');
        else setDeckState(slot, 'failed', result?.error || 'Compile failed');
      });

      const forScene = (prev, getValue) =>
        prev.map((value, i) => {
          if (Math.floor(i / CHANNELS) !== scene) return value;
          const cfg = entry.channels[i % CHANNELS];
          return cfg ? getValue(cfg, value) : value;
        });
      setOpacities((prev) => forScene(prev, (c, v) => c.opacity ?? v));
      setMuted((prev) => forScene(prev, (c, v) => c.muted ?? v));
      setScales((prev) => forScene(prev, (c, v) => c.scale ?? v));
      setSizes((prev) => forScene(prev, (c, v) => (c.size ? { ...c.size } : v)));
      setFx((prev) => forScene(prev, (c, v) => ({ ...DEFAULT_FX, ...(c.fx ?? v) })));
      setPrompts((prev) => forScene(prev, (c, v) => c.prompt ?? v));
    },
    [library, setDeckState],
  );

  const handleDeleteShader = useCallback(async (id) => {
    await deleteShader(id);
    setLibrary((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const handleRenameShader = useCallback(async (entry, name) => {
    try {
      const updated = await renameShader(entry, name);
      setLibrary((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } catch (err) {
      console.error('[Vizzy] Renaming shader failed:', err);
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    const devices = await audioRef.current.listDevices();
    setAudioDevices(devices);
  }, []);

  const handleToggleAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (audio.active) {
      await audio.stop();
      setAudioActive(false);
      return;
    }
    try {
      await audio.start(selectedDevice || undefined);
      setAudioActive(true);
      await refreshDevices(); // labels only populate after permission is granted
    } catch (err) {
      console.error('[Vizzy] Audio input failed:', err);
      setAudioActive(false);
    }
  }, [selectedDevice, refreshDevices]);

  const handleSelectDevice = useCallback(async (deviceId) => {
    setSelectedDevice(deviceId);
    const audio = audioRef.current;
    if (audio.active) {
      try {
        await audio.start(deviceId || undefined);
      } catch (err) {
        console.error('[Vizzy] Audio input failed:', err);
        setAudioActive(false);
      }
    }
  }, []);

  const handleModelChange = useCallback((value) => {
    setModel(value);
    modelRef.current = value;
    localStorage.setItem('vizzy.model', value);
  }, []);

  const handleToggleMidiLearn = useCallback(() => {
    setMidiLearn((prev) => {
      if (prev) {
        midiRef.current?.disarm();
        setArmedControl(null);
      }
      return !prev;
    });
  }, []);

  const handleArm = useCallback((controlId) => {
    midiRef.current?.arm(controlId);
    setArmedControl(controlId);
  }, []);

  const sceneLetter = SCENE_LETTERS[cueScene];

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      <TopBar
        libraryOpen={libraryOpen}
        onToggleLibrary={handleToggleLibrary}
        masterOpen={masterOpen}
        onToggleMaster={handleToggleMaster}
        audioActive={audioActive}
        audioDevices={audioDevices}
        selectedDevice={selectedDevice}
        onSelectDevice={handleSelectDevice}
        onToggleAudio={handleToggleAudio}
        model={model}
        onModelChange={handleModelChange}
        midiLearn={midiLearn}
        onToggleMidiLearn={handleToggleMidiLearn}
        midiInputs={midiInputs}
      />

      <div className="flex min-h-0 flex-1">
        <LibraryPanel
          open={libraryOpen}
          shaders={library.filter((e) => e.kind !== 'deck')}
          decks={library.filter((e) => e.kind === 'deck')}
          sceneLetter={sceneLetter}
          onSaveDeck={handleSaveDeckScene}
          onAssignDeck={handleAssignDeck}
          onDelete={handleDeleteShader}
          onRename={handleRenameShader}
          onAddToChannel={handleAddToChannel}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-44 flex-1 gap-3 p-3">
            <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-black">
              <canvas ref={sceneACanvasRef} className="block h-full w-full" />
              <span className="pointer-events-none absolute left-2 top-1.5 text-[10px] font-black tracking-widest text-cyan-400/80">
                SCENE A
              </span>
            </div>

            <Mixer
              opacities={opacities}
              muted={muted}
              onChange={applyOpacity}
              onToggleMute={toggleMute}
              crossfade={crossfade}
              onCrossfadeChange={applyCrossfade}
              cueScene={cueScene}
              onCue={setCueScene}
              midiLearn={midiLearn}
              armedControl={armedControl}
              onArm={handleArm}
              controlMap={controlMap}
            />

            <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-black">
              <canvas ref={sceneBCanvasRef} className="block h-full w-full" />
              <span className="pointer-events-none absolute right-2 top-1.5 text-[10px] font-black tracking-widest text-fuchsia-400/80">
                SCENE B
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3 p-3 pt-0">
            {[0, 1, 2, 3].map((channel) => {
              const slot = cueScene * CHANNELS + channel;
              return (
                <DeckModule
                  key={channel}
                  index={channel}
                  sceneLetter={sceneLetter}
                  status={decks[slot].status}
                  error={decks[slot].error}
                  prompt={prompts[slot]}
                  onPromptChange={handlePromptChange}
                  scale={scales[slot]}
                  onScaleChange={(ch, v) => applyScale(cueScene * CHANNELS + ch, v)}
                  size={sizes[slot]}
                  onSizeChange={(ch, axis, v) =>
                    applySize(cueScene * CHANNELS + ch, axis, v)
                  }
                  fx={fx[slot]}
                  onFxChange={(ch, key, v) => applyFx(cueScene * CHANNELS + ch, key, v)}
                  onGenerate={handleGenerate}
                  onSave={handleSaveDeck}
                  previewRef={(el) => {
                    previewRefs.current[channel] = el;
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
