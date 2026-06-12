const SCENE_META = [
  { letter: 'A', accent: 'cyan' },
  { letter: 'B', accent: 'fuchsia' },
];

interface StripProps {
  label: string;
  controlId: string;
  value: number;
  isMuted: boolean;
  midiLearn: boolean;
  armed: boolean;
  cc?: number;
  onChange: (value: number) => void;
  onArm: (controlId: string) => void;
  onToggleMute: () => void;
}

function Strip({
  label,
  controlId,
  value,
  isMuted,
  midiLearn,
  armed,
  cc,
  onChange,
  onArm,
  onToggleMute,
}: StripProps) {
  return (
    <div className="flex min-h-0 flex-col items-center gap-1.5">
      <div
        className={`flex min-h-0 flex-1 items-stretch rounded px-1 transition-opacity ${
          isMuted ? 'opacity-40' : ''
        } ${armed ? 'ring-2 ring-amber-400' : midiLearn ? 'ring-1 ring-amber-400/40' : ''}`}
      >
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerDown={() => {
            if (midiLearn) onArm(controlId);
          }}
          className="vert-slider"
          aria-label={`${label} opacity`}
        />
      </div>
      <span
        className={`w-7 text-center font-mono text-[9px] ${
          isMuted ? 'text-neutral-600 line-through' : 'text-neutral-300'
        }`}
      >
        {Math.round(value * 100)}
      </span>
      <span className="text-[9px] text-neutral-500">
        {armed ? 'move…' : cc != null ? `CC${cc}` : '—'}
      </span>
      <span className="text-[10px] font-bold text-neutral-400">{label}</span>
      <button
        type="button"
        onClick={onToggleMute}
        aria-pressed={isMuted}
        aria-label={`Mute ${label}`}
        className={`w-7 rounded-sm border py-0.5 text-[9px] font-black tracking-widest transition-all ${
          isMuted
            ? 'border-red-500 bg-red-500/25 text-red-300 shadow-[0_0_8px_rgba(239,68,68,0.55)]'
            : 'border-neutral-700 bg-neutral-950 text-neutral-500 hover:border-neutral-500 hover:text-neutral-300'
        }`}
      >
        M
      </button>
    </div>
  );
}

interface MixerProps {
  /** 8 values: A1-A4 then B1-B4 */
  opacities: number[];
  muted: boolean[];
  onChange: (slot: number, value: number) => void;
  onToggleMute: (slot: number) => void;
  crossfade: number;
  onCrossfadeChange: (value: number) => void;
  cueScene: number;
  onCue: (scene: number) => void;
  midiLearn: boolean;
  armedControl: string | null;
  onArm: (controlId: string) => void;
  controlMap: Record<string, number>;
}

export function Mixer({
  opacities,
  muted,
  onChange,
  onToggleMute,
  crossfade,
  onCrossfadeChange,
  cueScene,
  onCue,
  midiLearn,
  armedControl,
  onArm,
  controlMap,
}: MixerProps) {
  const xfadeArmed = armedControl === 'xfade';
  const xfadeCc = controlMap.xfade;

  return (
    <div className="flex min-h-0 shrink-0 flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-2">
      <span className="text-center text-xs font-bold tracking-widest text-neutral-400">
        MIXER
      </span>

      <div className="flex min-h-0 flex-1 gap-2">
        {SCENE_META.map(({ letter, accent }, scene) => {
          const cued = cueScene === scene;
          const ring = accent === 'cyan' ? 'ring-cyan-500/60' : 'ring-fuchsia-500/60';
          const cueActive =
            accent === 'cyan'
              ? 'bg-cyan-600 text-white shadow-[0_0_10px_rgba(34,211,238,0.4)]'
              : 'bg-fuchsia-600 text-white shadow-[0_0_10px_rgba(232,121,249,0.4)]';
          return (
            <div
              key={letter}
              className={`flex min-h-0 flex-col gap-1.5 rounded-md p-1.5 ${
                cued ? `bg-neutral-800/50 ring-1 ${ring}` : ''
              }`}
            >
              <button
                type="button"
                onClick={() => onCue(scene)}
                aria-pressed={cued}
                title={`Edit scene ${letter} in the deck builder below`}
                className={`rounded py-1 text-[10px] font-black tracking-widest transition-all ${
                  cued
                    ? cueActive
                    : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
                }`}
              >
                CUE {letter}
              </button>
              <div className="flex min-h-0 flex-1 gap-1.5">
                {[0, 1, 2, 3].map((ch) => {
                  const globalIndex = scene * 4 + ch;
                  const controlId = `${letter.toLowerCase()}_mix${ch + 1}`;
                  return (
                    <Strip
                      key={controlId}
                      label={`${letter}${ch + 1}`}
                      controlId={controlId}
                      value={opacities[globalIndex]}
                      isMuted={muted[globalIndex]}
                      midiLearn={midiLearn}
                      armed={armedControl === controlId}
                      cc={controlMap[controlId]}
                      onChange={(v) => onChange(globalIndex, v)}
                      onArm={onArm}
                      onToggleMute={() => onToggleMute(globalIndex)}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div
        className={`flex items-center gap-2 rounded px-1 py-0.5 ${
          xfadeArmed ? 'ring-2 ring-amber-400' : midiLearn ? 'ring-1 ring-amber-400/40' : ''
        }`}
      >
        <span className="text-[10px] font-black text-cyan-400">A</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={crossfade}
          onChange={(e) => onCrossfadeChange(Number(e.target.value))}
          onPointerDown={() => {
            if (midiLearn) onArm('xfade');
          }}
          onDoubleClick={() => onCrossfadeChange(crossfade < 0.5 ? 1 : 0)}
          title="Crossfade between scene A and scene B (double-click to flip)"
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-amber-500"
          aria-label="Scene crossfader"
        />
        <span className="text-[10px] font-black text-fuchsia-400">B</span>
      </div>
      <span className="text-center text-[9px] text-neutral-600">
        {xfadeArmed ? 'move a MIDI control…' : xfadeCc != null ? `XFADE · CC${xfadeCc}` : 'XFADE'}
      </span>
    </div>
  );
}
