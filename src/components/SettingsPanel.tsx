import { RENDER_PRESETS, type RenderResolution } from '../lib/renderSettings';

interface SettingsPanelProps {
  render: RenderResolution;
  onRenderChange: (next: RenderResolution) => void;
}

// Inline settings panel (drops below the top bar, like AudioMeterPanel). Today
// it holds the one device/performance preference: a master render-resolution
// cap that trades sharpness for frame rate on weak GPUs.
export function SettingsPanel({ render, onRenderChange }: SettingsPanelProps) {
  const presetValue = `${render.width}x${render.height}`;
  return (
    <div className="border-b border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
          Render resolution
        </span>

        <button
          type="button"
          onClick={() => onRenderChange({ ...render, enabled: !render.enabled })}
          title="Render the master output at a lower internal resolution and stretch it to the window — boosts frame rate on low-power GPUs (e.g. Raspberry Pi)"
          className={`rounded px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            render.enabled
              ? 'bg-emerald-600 text-white hover:bg-emerald-500'
              : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
          }`}
        >
          {render.enabled ? 'Limited' : 'Native'}
        </button>

        <select
          value={presetValue}
          disabled={!render.enabled}
          onChange={(e) => {
            const preset = RENDER_PRESETS.find((p) => `${p.width}x${p.height}` === e.target.value);
            if (preset) onRenderChange({ ...render, width: preset.width, height: preset.height });
          }}
          aria-label="Maximum render resolution"
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 focus:border-cyan-500 focus:outline-none disabled:opacity-40"
        >
          {RENDER_PRESETS.map((p) => (
            <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
              {p.label}
            </option>
          ))}
        </select>

        <span className="text-[10px] text-neutral-500">
          Caps the master output; the image is stretched to fill the window.
        </span>
      </div>
    </div>
  );
}
