import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DeckEntry, ModelEntry, SceneEntry, SpriteEntry, VideoEntry } from './types';
import { CHANNELS, SCENE_LETTERS, slotIndex } from './lib/channels';
import { TopBar } from './components/TopBar';
import { AudioMeterPanel } from './components/AudioMeterPanel';
import { BpmSyncBridge } from './components/BpmSyncBridge';
import { Tutorial } from './components/Tutorial';
import { WorkspaceProgress } from './components/WorkspaceProgress';
import { SetupScreen } from './components/SetupScreen';
import { DeckModule } from './components/DeckModule';
import { Mixer } from './components/Mixer';
import { LibraryPanel } from './components/LibraryPanel';
import { usePerformanceState } from './hooks/usePerformanceState';
import { useEngineRig, useEngineSync } from './hooks/useEngineRig';
import { useMidiControls } from './hooks/useMidiControls';
import { useMasterWindow } from './hooks/useMasterWindow';
import { PerformanceView } from './components/PerformanceView';
import { useLlmSetup } from './hooks/useLlmSetup';
import { useGeneration } from './hooks/useGeneration';
import { useAudioControls } from './hooks/useAudioControls';
import { useAudioMeters } from './hooks/useAudioMeters';
import { useSessionPersistence } from './hooks/useSessionPersistence';
import { useLibrary, isShaderEntry } from './hooks/useLibrary';
import { useUpdater } from './hooks/useUpdater';
import { UpdateBanner } from './components/UpdateBanner';
import { getPlatform } from './platform';

export default function App() {
  const sceneACanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneBCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // The performance layout (a full-screen reskin of this same window) owns its
  // own scene monitors; the engine is re-pointed at whichever pair is mounted.
  const perfACanvasRef = useRef<HTMLCanvasElement | null>(null);
  const perfBCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [performanceMode, setPerformanceMode] = useState(false);

  const perf = usePerformanceState();
  const llm = useLlmSetup();
  const updater = useUpdater();

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

  // Re-point the engine's scene monitors when toggling studio ↔ performance:
  // each layout mounts its own canvas pair, so after the swap commits we hand
  // the engine the now-mounted pair. The deck aspect follows the A view, and
  // both A canvases are 16:9, so the output shape is unchanged across the swap.
  useLayoutEffect(() => {
    const a = performanceMode ? perfACanvasRef.current : sceneACanvasRef.current;
    const b = performanceMode ? perfBCanvasRef.current : sceneBCanvasRef.current;
    engineRef.current?.setViewCanvases({ a, b });
  }, [engineRef, performanceMode]);

  // Live audio metering + the expandable meter panel.
  const meterStore = useAudioMeters(audioRef, perf.fx);
  const [meterPanelOpen, setMeterPanelOpen] = useState(false);
  const toggleMeterPanel = useCallback(() => setMeterPanelOpen((v) => !v), []);

  // Push per-layer beat-detector tuning to the native core whenever it changes
  // or capture (re)starts — so restored settings take effect on the next session.
  useEffect(() => {
    if (!audio.audioActive) return;
    void audioRef.current?.setBeatConfig(perf.beatBands);
  }, [audioRef, audio.audioActive, perf.beatBands]);

  // Texture sharing (Syphon/Spout) lives in the render core; mirror state here.
  const [syphonOn, setSyphonOn] = useState(false);
  useEffect(() => {
    engineRef.current?.onTextureShare(setSyphonOn);
  }, [engineRef]);
  const handleToggleSyphon = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    void engine
      .setTextureShare(!syphonOn)
      .then(setSyphonOn)
      .catch((err) => console.error('[Vizzy] Texture share failed:', err));
  }, [engineRef, syphonOn]);

  // Master glow (bloom) also lives in the render core; same mirror pattern.
  const [glowOn, setGlowOn] = useState(false);
  useEffect(() => {
    engineRef.current?.onGlow(setGlowOn);
  }, [engineRef]);
  const handleToggleGlow = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    void engine
      .setGlow(!glowOn)
      .then(setGlowOn)
      .catch((err) => console.error('[Vizzy] Glow toggle failed:', err));
  }, [engineRef, glowOn]);

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
    suspendAutosave: session.suspendAutosave,
    flushSession: session.flushSession,
  });

  // Native File menu (built in src-tauri): the OS menu items emit actions the
  // host forwards here, driving the same workspace handlers the UI used to.
  const { handleImportWorkspace, handleExportWorkspace, handleResetToDefaults } = library;
  const { checkNow: checkForUpdates } = updater;
  useEffect(() => {
    return getPlatform().onMenuAction((action) => {
      if (action === 'open-workspace') void handleImportWorkspace();
      else if (action === 'save-workspace') void handleExportWorkspace();
      else if (action === 'reset-app') void handleResetToDefaults();
      else if (action === 'check-updates') void checkForUpdates();
    });
  }, [handleImportWorkspace, handleExportWorkspace, handleResetToDefaults, checkForUpdates]);

  // Saved decks the performance view can cue, and the cue handler (loads a deck
  // onto a scene's 4 channels via the existing library path).
  const perfDecks = library.library.filter((e): e is DeckEntry => e.kind === 'deck');
  const handleCueDeck = useCallback(
    (deckId: string, scene: number) => {
      const deck = perfDecks.find((d) => d.id === deckId);
      if (deck) library.handleAssignDeck(deck, scene);
    },
    [perfDecks, library.handleAssignDeck],
  );

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
      <BpmSyncBridge store={meterStore} enabled={perf.bpmSync} applyBpm={perf.applyBpm} />

      {performanceMode ? (
        <PerformanceView
          perf={perf}
          decks={perfDecks}
          onCueDeck={handleCueDeck}
          onExit={() => setPerformanceMode(false)}
          aRef={perfACanvasRef}
          bRef={perfBCanvasRef}
        />
      ) : (
        <>
      <TopBar
        libraryOpen={library.libraryOpen}
        onToggleLibrary={library.handleToggleLibrary}
        masterOpen={master.masterOpen}
        onToggleMaster={master.handleToggleMaster}
        perfOpen={performanceMode}
        onTogglePerf={() => setPerformanceMode((v) => !v)}
        syphonOn={syphonOn}
        onToggleSyphon={handleToggleSyphon}
        glowOn={glowOn}
        onToggleGlow={handleToggleGlow}
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
        bpm={perf.bpm}
        onBpmChange={perf.applyBpm}
        meterStore={meterStore}
        meterPanelOpen={meterPanelOpen}
        onToggleMeterPanel={toggleMeterPanel}
      />

      {meterPanelOpen && (
        <AudioMeterPanel
          store={meterStore}
          fx={perf.fx}
          bpmSync={perf.bpmSync}
          onToggleBpmSync={perf.applyBpmSync}
          beatBands={perf.beatBands}
          onBeatBandChange={perf.applyBeatBand}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <LibraryPanel
          open={library.libraryOpen}
          shaders={library.library.filter(isShaderEntry)}
          scenes={library.library.filter((e): e is SceneEntry => e.kind === 'scene')}
          decks={library.library.filter((e): e is DeckEntry => e.kind === 'deck')}
          models={library.library.filter((e): e is ModelEntry => e.kind === 'model')}
          sprites={library.library.filter((e): e is SpriteEntry => e.kind === 'sprite')}
          videos={library.library.filter((e): e is VideoEntry => e.kind === 'video')}
          sceneLetter={sceneLetter}
          onSaveDeck={library.handleSaveDeckScene}
          onAssignDeck={library.handleAssignDeck}
          onAddPaths={library.handleAddPaths}
          onAssignModel={library.handleAssignModel}
          onAssignLandscape={library.handleAssignLandscape}
          onAssignSprite={library.handleAssignSprite}
          onAssignVideo={library.handleAssignVideo}
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
                  tile={perf.tiles[slot]}
                  onTileChange={(ch: number, v: boolean) =>
                    perf.applyTile(slotIndex(perf.cueScene, ch), v)
                  }
                  loop={perf.loops[slot]}
                  onLoopChange={(ch, next) => perf.applyLoop(slotIndex(perf.cueScene, ch), next)}
                  sourceType={perf.sourceTypes[slot]}
                  fx={perf.fx[slot]}
                  onFxChange={(ch, key, v) => perf.applyFx(slotIndex(perf.cueScene, ch), key, v)}
                  filter={perf.filters[slot]}
                  onFilterChange={(ch, key, v) =>
                    perf.applyFilter(slotIndex(perf.cueScene, ch), key, v)
                  }
                  aut={perf.aut[slot]}
                  onAutChange={(ch, effect, field, v) =>
                    perf.applyAut(slotIndex(perf.cueScene, ch), effect, field, v)
                  }
                  videoPlayback={perf.videoPlayback[slot]}
                  onVideoChange={(ch, key, v) =>
                    perf.applyVideoPlayback(slotIndex(perf.cueScene, ch), key, v)
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
        </>
      )}

      <Tutorial open={tutorialOpen} onClose={() => setTutorialOpen(false)} />
      <WorkspaceProgress progress={library.exportProgress} />
      <UpdateBanner state={updater.state} onInstall={updater.install} onDismiss={updater.dismiss} />
    </div>
  );
}
