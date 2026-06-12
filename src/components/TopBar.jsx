import { useState } from 'react';
import { MODEL_CATALOG } from '../llm/models';

const CUSTOM = '__custom__';

export function TopBar({
  libraryOpen,
  onToggleLibrary,
  masterOpen,
  onToggleMaster,
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
}) {
  const inCatalog = MODEL_CATALOG.some((m) => m.tag === model);
  const [customMode, setCustomMode] = useState(!inCatalog);
  const showCustom = customMode || !inCatalog;
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
