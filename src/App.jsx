import { useCallback, useEffect, useRef, useState } from 'react';
import { RenderEngine } from './engine/RenderEngine';
import { AudioEngine } from './engine/AudioEngine';
import { MidiEngine } from './engine/MidiEngine';
import { GenerationQueue, DEFAULT_MODEL } from './llm/ollama';
import { extractShaderCode } from './llm/parser';
import { TopBar } from './components/TopBar';
import { DeckModule } from './components/DeckModule';
import { Mixer } from './components/Mixer';
import { LibraryPanel } from './components/LibraryPanel';
import { listShaders, saveShader, renameShader, deleteShader } from './lib/shaderLibrary';

const DECK_COUNT = 4;
const INITIAL_OPACITIES = [1, 0, 0, 0];

export default function App() {
  const masterCanvasRef = useRef(null);
  const previewRefs = useRef([]);
  const engineRef = useRef(null);
  const audioRef = useRef(null);
  const midiRef = useRef(null);
  const queueRef = useRef(null);
  const modelRef = useRef(localStorage.getItem('promptvj.model') || DEFAULT_MODEL);

  const [decks, setDecks] = useState(() =>
    Array.from({ length: DECK_COUNT }, () => ({ status: 'idle', error: null })),
  );
  const [opacities, setOpacities] = useState(INITIAL_OPACITIES);
  const [muted, setMuted] = useState(() => Array(DECK_COUNT).fill(false));
  const [scales, setScales] = useState(() => Array(DECK_COUNT).fill(1));
  const [sizes, setSizes] = useState(() =>
    Array.from({ length: DECK_COUNT }, () => ({ x: 1, y: 1 })),
  );
  const [audioActive, setAudioActive] = useState(false);
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [model, setModel] = useState(modelRef.current);
  const [library, setLibrary] = useState([]);
  const [libraryOpen, setLibraryOpen] = useState(
    () => localStorage.getItem('promptvj.libraryOpen') === '1',
  );
  const [midiLearn, setMidiLearn] = useState(false);
  const [armedControl, setArmedControl] = useState(null);
  const [controlMap, setControlMap] = useState({});
  const [midiInputs, setMidiInputs] = useState(0);

  const setDeckState = useCallback((index, status, error = null) => {
    setDecks((prev) => prev.map((d, i) => (i === index ? { status, error } : d)));
  }, []);

  const applyOpacity = useCallback((index, value) => {
    setOpacities((prev) => prev.map((v, i) => (i === index ? value : v)));
  }, []);

  const toggleMute = useCallback((index) => {
    setMuted((prev) => prev.map((m, i) => (i === index ? !m : m)));
  }, []);

  const applyScale = useCallback((index, value) => {
    setScales((prev) => prev.map((v, i) => (i === index ? value : v)));
  }, []);

  const applySize = useCallback((index, axis, value) => {
    setSizes((prev) => prev.map((s, i) => (i === index ? { ...s, [axis]: value } : s)));
  }, []);

  // Single sync point for the composite uniforms: a muted channel outputs 0
  // while its fader position is preserved for unmute.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    opacities.forEach((value, i) => engine.setOpacity(i, muted[i] ? 0 : value));
    scales.forEach((value, i) => engine.setScale(i, value));
    sizes.forEach((size, i) => engine.setSize(i, size.x, size.y));
  }, [opacities, muted, scales, sizes]);

  useEffect(() => {
    const audio = new AudioEngine();
    audioRef.current = audio;

    const engine = new RenderEngine(masterCanvasRef.current, previewRefs.current, audio);
    engineRef.current = engine;

    queueRef.current = new GenerationQueue({
      getModel: () => modelRef.current,
      onStatus: setDeckState,
    });

    const midi = new MidiEngine({
      onControlValue: (controlId, value) => {
        const match = controlId.match(/^mix(\d)$/);
        if (match) applyOpacity(Number(match[1]) - 1, value);
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
      .catch((err) => console.warn('[PromptVJ] MIDI unavailable:', err));

    return () => {
      engine.dispose();
      audio.stop();
      midi.dispose();
    };
  }, [setDeckState, applyOpacity]);

  useEffect(() => {
    listShaders()
      .then(setLibrary)
      .catch((err) => console.warn('[PromptVJ] Could not load shader library:', err));
  }, []);

  const handleToggleLibrary = useCallback(() => {
    setLibraryOpen((prev) => {
      localStorage.setItem('promptvj.libraryOpen', prev ? '0' : '1');
      return !prev;
    });
  }, []);

  const handleSaveDeck = useCallback(async (index) => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      const entry = await saveShader({
        code: engine.getShaderBody(index),
        screenshot: engine.getPreviewDataURL(index),
      });
      setLibrary((prev) => [entry, ...prev]);
    } catch (err) {
      console.error('[PromptVJ] Saving shader failed:', err);
    }
  }, []);

  const handleDeleteShader = useCallback(async (id) => {
    await deleteShader(id);
    setLibrary((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const handleRenameShader = useCallback(async (entry, name) => {
    try {
      const updated = await renameShader(entry, name);
      setLibrary((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } catch (err) {
      console.error('[PromptVJ] Renaming shader failed:', err);
    }
  }, []);

  const handleAddToChannel = useCallback(
    (entry, channel) => {
      const result = engineRef.current?.stageShader(channel, entry.code);
      if (result?.ok) setDeckState(channel, 'active');
      else setDeckState(channel, 'failed', result?.error || 'Compile failed');
    },
    [setDeckState],
  );

  const handleGenerate = useCallback(
    (index, prompt) => {
      queueRef.current?.enqueue(index, prompt, (raw) => {
        const code = extractShaderCode(raw);
        if (!code) {
          setDeckState(index, 'failed', 'No GLSL main() block found in the model response');
          return;
        }
        setDeckState(index, 'compiling');
        const result = engineRef.current.stageShader(index, code);
        if (result.ok) setDeckState(index, 'active');
        else setDeckState(index, 'failed', result.error);
      });
    },
    [setDeckState],
  );

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
      console.error('[PromptVJ] Audio input failed:', err);
      setAudioActive(false);
    }
  }, [selectedDevice, refreshDevices]);

  const handleSelectDevice = useCallback(
    async (deviceId) => {
      setSelectedDevice(deviceId);
      const audio = audioRef.current;
      if (audio.active) {
        try {
          await audio.start(deviceId || undefined);
        } catch (err) {
          console.error('[PromptVJ] Audio input failed:', err);
          setAudioActive(false);
        }
      }
    },
    [],
  );

  const handleModelChange = useCallback((value) => {
    setModel(value);
    modelRef.current = value;
    localStorage.setItem('promptvj.model', value);
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

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      <TopBar
        libraryOpen={libraryOpen}
        onToggleLibrary={handleToggleLibrary}
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
          shaders={library}
          onDelete={handleDeleteShader}
          onRename={handleRenameShader}
          onAddToChannel={handleAddToChannel}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 gap-3 p-3">
            <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-black">
              <canvas ref={masterCanvasRef} className="block h-full w-full" />
            </div>
            <Mixer
              opacities={opacities}
              muted={muted}
              onChange={applyOpacity}
              onToggleMute={toggleMute}
              midiLearn={midiLearn}
              armedControl={armedControl}
              onArm={handleArm}
              controlMap={controlMap}
            />
          </div>

          <div className="grid grid-cols-4 gap-3 p-3 pt-0">
            {decks.map((deck, i) => (
              <DeckModule
                key={i}
                index={i}
                status={deck.status}
                error={deck.error}
                scale={scales[i]}
                onScaleChange={applyScale}
                size={sizes[i]}
                onSizeChange={applySize}
                onGenerate={handleGenerate}
                onSave={handleSaveDeck}
                previewRef={(el) => {
                  previewRefs.current[i] = el;
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
