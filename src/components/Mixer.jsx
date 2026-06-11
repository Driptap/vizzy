export function Mixer({
  opacities,
  muted,
  onChange,
  onToggleMute,
  midiLearn,
  armedControl,
  onArm,
  controlMap,
}) {
  return (
    <div className="flex flex-col rounded-lg border border-neutral-800 bg-neutral-900 p-3">
      <span className="mb-2 text-center text-xs font-bold tracking-widest text-neutral-400">
        MIXER
      </span>
      <div className="flex min-h-0 flex-1 gap-3">
        {opacities.map((value, i) => {
          const controlId = `mix${i + 1}`;
          const armed = armedControl === controlId;
          const cc = controlMap[controlId];
          const isMuted = muted[i];
          return (
            <div key={controlId} className="flex min-h-0 flex-col items-center gap-1.5">
              <div
                className={`flex min-h-0 flex-1 items-stretch rounded px-1 transition-opacity ${
                  isMuted ? 'opacity-40' : ''
                } ${
                  armed
                    ? 'ring-2 ring-amber-400'
                    : midiLearn
                      ? 'ring-1 ring-amber-400/40'
                      : ''
                }`}
              >
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={value}
                  onChange={(e) => onChange(i, Number(e.target.value))}
                  onPointerDown={() => {
                    if (midiLearn) onArm(controlId);
                  }}
                  className="vert-slider"
                  aria-label={`Deck ${i + 1} opacity`}
                />
              </div>
              <span
                className={`w-8 text-center font-mono text-[10px] ${
                  isMuted ? 'text-neutral-600 line-through' : 'text-neutral-300'
                }`}
              >
                {Math.round(value * 100)}
              </span>
              <span className="text-[9px] text-neutral-500">
                {armed ? 'move…' : cc != null ? `CC${cc}` : '—'}
              </span>
              <span className="text-[10px] font-bold text-neutral-400">D{i + 1}</span>
              <button
                type="button"
                onClick={() => onToggleMute(i)}
                aria-pressed={isMuted}
                aria-label={`Mute deck ${i + 1}`}
                className={`w-9 rounded-sm border py-1 text-[9px] font-black tracking-widest transition-all ${
                  isMuted
                    ? 'border-red-500 bg-red-500/25 text-red-300 shadow-[0_0_8px_rgba(239,68,68,0.55)]'
                    : 'border-neutral-700 bg-neutral-950 text-neutral-500 hover:border-neutral-500 hover:text-neutral-300'
                }`}
              >
                M
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
