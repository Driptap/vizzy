export function TopBar({
  libraryOpen,
  onToggleLibrary,
  audioActive,
  audioDevices,
  selectedDevice,
  onSelectDevice,
  onToggleAudio,
  model,
  onModelChange,
  midiLearn,
  onToggleMidiLearn,
  midiInputs,
}) {
  return (
    <div className="flex items-center gap-4 border-b border-neutral-800 bg-neutral-900 px-4 py-2.5">
      <h1 className="text-sm font-black tracking-widest text-cyan-400">
        PROMPT<span className="text-neutral-200">VJ</span>
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
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">Model</span>
        <input
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          spellCheck={false}
          className="w-36 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 focus:border-cyan-500 focus:outline-none"
        />
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
      </div>
    </div>
  );
}
