import { useCallback, useRef, useState } from 'react';
import type { DeckEntry, ModelEntry, SceneEntry, SpriteEntry } from './types';
import { CHANNELS, SCENE_LETTERS, slotIndex } from './lib/channels';
import { TopBar } from './components/TopBar';
import { Tutorial } from './components/Tutorial';
import { SetupScreen } from './components/SetupScreen';
import { DeckModule } from './components/DeckModule';
import { Mixer } from './components/Mixer';
import { LibraryPanel } from './components/LibraryPanel';
import { usePerformanceState } from './hooks/usePerformanceState';
import { useEngineRig, useEngineSync } from './hooks/useEngineRig';
import { useMidiControls } from './hooks/useMidiControls';
import { useMasterWindow } from './hooks/useMasterWindow';
import { useLlmSetup } from './hooks/useLlmSetup';
import { useGeneration } from './hooks/useGeneration';
import { useAudioControls } from './hooks/useAudioControls';
import { useSessionPersistence } from './hooks/useSessionPersistence';
import { useLibrary, isShaderEntry } from './hooks/useLibrary';

export default function App() {
  const sceneACanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneBCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [tutorialOpen, setTutorialOpen] = useState(false);

  const perf = usePerformanceState();
  const llm = useLlmSetup();

  const rig = useEngineRig({
    sceneACanvasRef,
    sceneBCanvasRef,
    previewRefs,
    getModel: () => llm.modelRef.current,
    onDeckStatus: perf.setDeckState,
  });
  const { engineRef, audioRef, queueRef } = rig;

  useEngineSync(engineRef, perf);

  const audio = useAudioControls(audioRef);
  const master = useMasterWindow(engineRef);

  const handleMidiControl = useCallback(
    (controlId: string, value: number) => {
      if (controlId === 'xfade') {
        perf.applyCrossfade(value);
        return;
      }
      const match = controlId.match(/^([ab])_mix([1-4])$/);
      if (match) {
        perf.applyOpacity(slotIndex(match[1] === 'b' ? 1 : 0, Number(match[2]) - 1), value);
      }
    },
    [perf.applyCrossfade, perf.applyOpacity],
  );
  const midi = useMidiControls({ onControlValue: handleMidiControl });

  const generation = useGeneration({
    engineRef,
    queueRef,
    cueScene: perf.cueScene,
    setDeckState: perf.setDeckState,
    setSourceType: perf.setSourceType,
  });

  const session = useSessionPersistence({
    engineRef,
    state: perf,
    setDeckState: perf.setDeckState,
    setSourceType: perf.setSourceType,
    restoreFromSession: perf.restoreFromSession,
  });

  const library = useLibrary({
    engineRef,
    perf,
    restoreSession: session.restoreSession,
    loadSavedSession: session.loadSavedSession,
    markSessionReady: session.markSessionReady,
  });

  const handlePromptChange = useCallback(
    (channel: number, text: string) => perf.setPrompt(slotIndex(perf.cueScene, channel), text),
    [perf.setPrompt, perf.cueScene],
  );

  // Blank rig: baseline shaders on every deck, neutral mixer; library intact.
  const handleResetRig = useCallback(() => {
    engineRef.current?.resetAllDecks();
    perf.resetPerformance();
  }, [engineRef, perf.resetPerformance]);

  const sceneLetter = SCENE_LETTERS[perf.cueScene];

  return (
    <div className="relative flex h-screen flex-col bg-neutral-950 text-neutral-200">
      {llm.setupOpen && (
        <SetupScreen
          model={llm.model}
          onModelChange={llm.handleModelChange}
          onReady={llm.handleSetupReady}
          onSkip={() => llm.setSetupOpen(false)}
        />
      )}
      <TopBar
        libraryOpen={library.libraryOpen}
        onToggleLibrary={library.handleToggleLibrary}
        masterOpen={master.masterOpen}
        onToggleMaster={master.handleToggleMaster}
        audioActive={audio.audioActive}
        audioDevices={audio.audioDevices}
        selectedDevice={audio.selectedDevice}
        onSelectDevice={audio.handleSelectDevice}
        onToggleAudio={audio.handleToggleAudio}
        model={llm.model}
        onModelChange={llm.handleModelChange}
        installedModels={llm.installedModels}
        llmReady={llm.llmReady}
        onOpenSetup={() => llm.setSetupOpen(true)}
        midiLearn={midi.midiLearn}
        onToggleMidiLearn={midi.handleToggleMidiLearn}
        midiInputs={midi.midiInputs}
        onOpenTutorial={() => setTutorialOpen(true)}
        onResetRig={handleResetRig}
      />

      <div className="flex min-h-0 flex-1">
        <LibraryPanel
          open={library.libraryOpen}
          shaders={library.library.filter(isShaderEntry)}
          scenes={library.library.filter((e): e is SceneEntry => e.kind === 'scene')}
          decks={library.library.filter((e): e is DeckEntry => e.kind === 'deck')}
          models={library.library.filter((e): e is ModelEntry => e.kind === 'model')}
          sprites={library.library.filter((e): e is SpriteEntry => e.kind === 'sprite')}
          sceneLetter={sceneLetter}
          onSaveDeck={library.handleSaveDeckScene}
          onAssignDeck={library.handleAssignDeck}
          onAddModels={library.handleAddModels}
          onAssignModel={library.handleAssignModel}
          onAssignLandscape={library.handleAssignLandscape}
          onAddSprites={library.handleAddSprites}
          onAssignSprite={library.handleAssignSprite}
          onAssignScene={library.handleAssignScene}
          onDelete={library.handleDeleteEntry}
          onRename={library.handleRenameShader}
          onAddToChannel={library.handleAddToChannel}
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
              opacities={perf.opacities}
              muted={perf.muted}
              onChange={perf.applyOpacity}
              onToggleMute={perf.toggleMute}
              crossfade={perf.crossfade}
              onCrossfadeChange={perf.applyCrossfade}
              cueScene={perf.cueScene}
              onCue={perf.setCueScene}
              midiLearn={midi.midiLearn}
              armedControl={midi.armedControl}
              onArm={midi.handleArm}
              controlMap={midi.controlMap}
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
              const slot = slotIndex(perf.cueScene, channel);
              return (
                <DeckModule
                  key={channel}
                  index={channel}
                  sceneLetter={sceneLetter}
                  status={perf.decks[slot].status}
                  error={perf.decks[slot].error}
                  prompt={perf.prompts[slot]}
                  onPromptChange={handlePromptChange}
                  scale={perf.scales[slot]}
                  onScaleChange={(ch: number, v: number) => perf.applyScale(slotIndex(perf.cueScene, ch), v)}
                  size={perf.sizes[slot]}
                  onSizeChange={(ch: number, axis: 'x' | 'y', v: number) =>
                    perf.applySize(slotIndex(perf.cueScene, ch), axis, v)
                  }
                  pos={perf.positions[slot]}
                  onPosChange={(ch: number, axis: 'x' | 'y', v: number) =>
                    perf.applyPos(slotIndex(perf.cueScene, ch), axis, v)
                  }
                  light={perf.lights[slot]}
                  onLightChange={(ch, key, v) =>
                    perf.applyLight(slotIndex(perf.cueScene, ch), key, v)
                  }
                  layer={perf.layers[slot]}
                  onLayerChange={(ch: number, l: number) =>
                    perf.applyLayer(slotIndex(perf.cueScene, ch), l)
                  }
                  sourceType={perf.sourceTypes[slot]}
                  fx={perf.fx[slot]}
                  onFxChange={(ch, key, v) => perf.applyFx(slotIndex(perf.cueScene, ch), key, v)}
                  aut={perf.aut[slot]}
                  onAutChange={(ch, effect, field, v) =>
                    perf.applyAut(slotIndex(perf.cueScene, ch), effect, field, v)
                  }
                  onGenerate={generation.handleGenerate}
                  onRegenerate={generation.handleRegenerate}
                  onSave={library.handleSaveDeck}
                  onReset={(ch: number) => perf.resetChannelConfig(slotIndex(perf.cueScene, ch))}
                  previewRef={(el: HTMLCanvasElement | null) => {
                    previewRefs.current[channel] = el;
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <Tutorial open={tutorialOpen} onClose={() => setTutorialOpen(false)} />
    </div>
  );
}
