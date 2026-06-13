import { useEffect, useRef, useState } from 'react';
import { MODEL_CATALOG } from '../llm/models';

const CUSTOM = '__custom__';

// Texture sharing publishes the master over the platform-native protocol:
// Syphon on macOS, Spout on Windows. Name the toggle after whichever the
// user's receiver software (Resolume, MadMapper, OBS) will list it under.
const SHARE_PROTOCOL = /Windows/i.test(navigator.userAgent) ? 'Spout' : 'Syphon';

interface TopBarProps {
  libraryOpen: boolean;
  onToggleLibrary: () => void;
  masterOpen: boolean;
  onToggleMaster: () => void;
  syphonOn: boolean;
  onToggleSyphon: () => void;
  glowOn: boolean;
  onToggleGlow: () => void;
  audioActive: boolean;
  audioDevices: MediaDeviceInfo[];
  selectedDevice: string;
  onSelectDevice: (deviceId: string) => void;
  onToggleAudio: () => void;
  model: string;
  onModelChange: (tag: string) => void;
  installedModels: string[];
  llmReady: boolean;
  onOpenSetup: () => void;
  midiLearn: boolean;
  onToggleMidiLearn: () => void;
  midiInputs: number;
  onOpenTutorial: () => void;
  onResetRig: () => void;
  bpm: number;
  onBpmChange: (bpm: number) => void;
}

export function TopBar({
  libraryOpen,
  onToggleLibrary,
  masterOpen,
  onToggleMaster,
  syphonOn,
  onToggleSyphon,
  glowOn,
  onToggleGlow,
  audioActive,
  audioDevices,
  selectedDevice,
  onSelectDevice,
  onToggleAudio,
  model,
  onModelChange,
  installedModels,
  llmReady,
  onOpenSetup,
  midiLearn,
  onToggleMidiLearn,
  midiInputs,
  onOpenTutorial,
  onResetRig,
  bpm,
  onBpmChange,
}: TopBarProps) {
  const inCatalog = MODEL_CATALOG.some((m) => m.tag === model);
  const [customMode, setCustomMode] = useState(!inCatalog);
  const showCustom = customMode || !inCatalog;

  // two-click confirm: a stray click mid-set must never wipe the rig
  const [resetArmed, setResetArmed] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimerRef.current), []);
  const handleResetClick = () => {
    if (resetArmed) {
      clearTimeout(resetTimerRef.current);
      setResetArmed(false);
      onResetRig();
      return;
    }
    setResetArmed(true);
    resetTimerRef.current = setTimeout(() => setResetArmed(false), 3000);
  };
  return (
    <div className="flex items-center gap-4 border-b border-neutral-800 bg-neutral-900 px-4 py-2.5">
      <h1 className="text-sm font-black tracking-widest text-cyan-400">
        VIZ<span className="text-neutral-200">ZY</span>
      </h1>

      <button
        type="button"
        onClick={onToggleLibrary}
        className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
          libraryOpen
            ? 'bg-cyan-600 text-white hover:bg-cyan-500'
            : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
        }`}
      >
        Library
      </button>

      <button
        type="button"
        onClick={onToggleMaster}
        title="Open the crossfaded master output in its own window (double-click it for fullscreen)"
        className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
          masterOpen
            ? 'bg-amber-500 text-black hover:bg-amber-400'
            : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
        }`}
      >
        {masterOpen ? '● Master Out' : 'Master Out'}
      </button>

      <button
        type="button"
        onClick={onToggleSyphon}
        title={`Share the master output with other VJ apps (Resolume, MadMapper, OBS) over ${SHARE_PROTOCOL}`}
        className={`whitespace-nowrap rounded px-3 py-1 text-xs font-semibold transition-colors ${
          syphonOn
            ? 'bg-fuchsia-600 text-white hover:bg-fuchsia-500'
            : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
        }`}
      >
        {/* dot always occupies its slot so the button never resizes */}
        <span aria-hidden className={`mr-1 ${syphonOn ? '' : 'opacity-0'}`}>
          ●
        </span>
        {SHARE_PROTOCOL}
      </button>

      <button
        type="button"
        onClick={onToggleGlow}
        title="Soft bloom on the master output — bright areas spill a tasteful stage glow"
        className={`whitespace-nowrap rounded px-3 py-1 text-xs font-semibold transition-colors ${
          glowOn
            ? 'bg-violet-600 text-white hover:bg-violet-500'
            : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
        }`}
      >
        <span aria-hidden className={`mr-1 ${glowOn ? '' : 'opacity-0'}`}>
          ●
        </span>
        Glow
      </button>

      <div className="ml-4 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">Audio</span>
        <select
          value={selectedDevice}
          onChange={(e) => onSelectDevice(e.target.value)}
          className="max-w-48 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 focus:border-cyan-500 focus:outline-none"
        >
          <option value="">Default input</option>
          {audioDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Input ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onToggleAudio}
          className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
            audioActive
              ? 'bg-emerald-600 text-white hover:bg-emerald-500'
              : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
          }`}
        >
          {audioActive ? '● Live' : 'Enable Audio'}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenSetup}
          title={llmReady ? 'LLM connected — open model manager' : 'LLM not set up — click to fix'}
          className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
            llmReady
              ? 'text-emerald-400 hover:bg-neutral-800'
              : 'bg-amber-500 text-black hover:bg-amber-400'
          }`}
        >
          {llmReady ? '● LLM' : 'Setup LLM'}
        </button>
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">Model</span>
        <select
          value={showCustom ? CUSTOM : model}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustomMode(true);
            } else {
              setCustomMode(false);
              onModelChange(e.target.value);
            }
          }}
          title="Curated open models — download size · RAM needed"
          className="max-w-56 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 focus:border-cyan-500 focus:outline-none"
        >
          {MODEL_CATALOG.map((m) => (
            <option key={m.tag} value={m.tag}>
              {m.name} — {m.download} · {m.ram} RAM
              {installedModels?.includes(m.tag) ? '' : ' (not downloaded)'}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
        {showCustom && (
          <input
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            spellCheck={false}
            placeholder="any ollama tag"
            className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 focus:border-cyan-500 focus:outline-none"
          />
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-1" title="Global tempo — drives every deck's looper">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">BPM</span>
          <input
            type="number"
            min={40}
            max={220}
            value={bpm}
            onChange={(e) => onBpmChange(Number(e.target.value))}
            aria-label="Tempo in BPM"
            className="w-14 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-center text-xs text-neutral-300 focus:border-cyan-500 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={handleResetClick}
          title="Clear all decks and the mixer back to defaults — the library is untouched"
          className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
            resetArmed
              ? 'bg-red-600 text-white hover:bg-red-500'
              : 'bg-neutral-700 text-neutral-200 hover:bg-red-900/70 hover:text-red-200'
          }`}
        >
          {resetArmed ? 'Sure? Click again' : 'Reset Rig'}
        </button>
        <span className="text-[10px] text-neutral-500">
          {midiInputs > 0 ? `${midiInputs} MIDI in` : 'No MIDI'}
        </span>
        <button
          type="button"
          onClick={onToggleMidiLearn}
          className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
            midiLearn
              ? 'bg-amber-500 text-black hover:bg-amber-400'
              : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
          }`}
        >
          {midiLearn ? 'MIDI Learn: ON' : 'MIDI Learn'}
        </button>
        <button
          type="button"
          onClick={onOpenTutorial}
          title="Quick tour: master view, audio, decks, library, mixing"
          aria-label="Open tutorial"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-700 text-xs font-bold text-neutral-200 transition-colors hover:bg-cyan-600 hover:text-white"
        >
          ?
        </button>
      </div>
    </div>
  );
}
