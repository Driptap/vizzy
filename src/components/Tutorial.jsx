import { useEffect, useState } from 'react';

const STEPS = [
  {
    label: 'MASTER',
    title: 'Master view',
    body: 'The Master Out button opens the final, crossfaded output in its own window — drag it onto your projector and double-click for fullscreen. That window also defines the render shape: resize it and the in-app scene views letterbox to match, so what you see is exactly what goes out.',
  },
  {
    label: 'AUDIO',
    title: 'Sound monitoring',
    body: 'Pick an input device in the top bar and hit Enable Audio. Vizzy measures four smoothed bands — low, mid, high and overall level — and feeds them to every visual. Each channel can choose which band drives it and how hard in its AUDIO tab (BAND + AMT), and automation effects with ♪ lit follow the same routing.',
  },
  {
    label: 'DECK A',
    title: 'Left deck (Scene A)',
    body: 'The left view is Scene A: channels A1–A4. Press CUE A and the four builder cards below edit those channels — type a prompt and Generate a shader with the local LLM, or right-click anything in the Library to assign it. Each card has its own preview, W/H footprint, and knobs for transform, audio routing and colour.',
  },
  {
    label: 'DECK B',
    title: 'Right deck (Scene B)',
    body: 'Same thing on the right: CUE B switches the builder row to channels B1–B4. The side views always show each scene’s full mix, so you can build B quietly while A is live — its faders don’t touch the output until the crossfader brings it in.',
  },
  {
    label: 'LIBRARY',
    title: 'Library',
    body: 'The Library button slides out your collection: shaders, whole deck presets, 3D models and image sprites. SAVE on a channel captures its running shader instantly (no naming mid-set — rename later). SAVE DECK stores all four channels of the cued scene with their full config. Right-click any entry to assign, rename or delete; drop .glb/.png files straight onto the 3D/IMG tabs.',
  },
  {
    label: 'MIXING',
    title: 'Mixing',
    body: 'Each channel has a fader and an M mute; the A–B crossfader at the bottom of the mixer blends the two scenes into the master (double-click it to snap-flip). Shape channels live with SCALE, W/H, TILT and the colour knobs. For hands-on control, toggle MIDI Learn, click any fader or the crossfader, and move a hardware control to bind it.',
  },
];

export function Tutorial({ open, onClose }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setStep((s) => Math.min(STEPS.length - 1, s + 1));
      if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[440px] rounded-lg border border-neutral-700 bg-neutral-900 p-5 shadow-2xl shadow-black/60">
        <div className="mb-3 flex items-center justify-between">
          <span className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] font-black tracking-widest text-cyan-300">
            {current.label}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tutorial"
            className="rounded px-2 text-sm text-neutral-500 hover:text-neutral-200"
          >
            ✕
          </button>
        </div>

        <h2 className="mb-2 text-base font-bold text-neutral-100">{current.title}</h2>
        <p className="min-h-28 text-sm leading-relaxed text-neutral-300">{current.body}</p>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((s, i) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setStep(i)}
                aria-label={`Step ${i + 1}: ${s.title}`}
                className={`h-1.5 w-5 rounded-full transition-colors ${
                  i === step ? 'bg-cyan-400' : 'bg-neutral-700 hover:bg-neutral-500'
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              className="rounded px-3 py-1 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => (isLast ? onClose() : setStep((s) => s + 1))}
              className="rounded bg-cyan-600 px-4 py-1 text-xs font-semibold text-white hover:bg-cyan-500"
            >
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
