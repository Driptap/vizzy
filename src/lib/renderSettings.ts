// App-wide render-output preference (not per-session): an optional cap on the
// master render resolution. When enabled, the native engine renders the master
// offscreen target no larger than the chosen box (aspect preserved) and the
// window present blit stretches it back to native size — a performance lever
// for low-power GPUs (e.g. a Raspberry Pi driving a 1080p output). Stored in
// localStorage like the other UI prefs; off by default.
import { getStored, setStored } from './storage';

const STORAGE_KEY = 'renderResolution';

export interface RenderResolution {
  enabled: boolean;
  /** Max render width in px (the cap box; aspect is preserved on the engine). */
  width: number;
  /** Max render height in px. */
  height: number;
}

/** Selectable caps, labelled by their 16:9 resolution (the common output shape). */
export const RENDER_PRESETS: { label: string; width: number; height: number }[] = [
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '540p (960×540)', width: 960, height: 540 },
  { label: '480p (854×480)', width: 854, height: 480 },
  { label: '360p (640×360)', width: 640, height: 360 },
];

export const DEFAULT_RENDER_RESOLUTION: RenderResolution = {
  enabled: false,
  width: 1280,
  height: 720,
};

export function loadRenderResolution(): RenderResolution {
  const raw = getStored(STORAGE_KEY);
  if (!raw) return DEFAULT_RENDER_RESOLUTION;
  try {
    const parsed = JSON.parse(raw) as Partial<RenderResolution>;
    return {
      enabled: Boolean(parsed.enabled),
      width: Number(parsed.width) || DEFAULT_RENDER_RESOLUTION.width,
      height: Number(parsed.height) || DEFAULT_RENDER_RESOLUTION.height,
    };
  } catch {
    return DEFAULT_RENDER_RESOLUTION;
  }
}

export function saveRenderResolution(value: RenderResolution): void {
  setStored(STORAGE_KEY, JSON.stringify(value));
}
