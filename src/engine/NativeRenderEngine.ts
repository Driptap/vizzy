// Tauri-native render client. The wgpu engine in src-tauri/src/render is
// self-driving: it evaluates loops, AUT effects, audio routing and deck
// animation on its own clock, so the master output never depends on this
// webview being visible. This class is a thin state mirror — knob setters
// mutate a snapshot that's coalesced into one render_state push per ~frame —
// plus the staging entry points and the streamed-frame canvas painter.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { DEFAULT_DECK_PATCHES } from '../lib/patches';
import { buildSceneBuffers } from '../lib/sceneGenerator';
import type {
  AudioBand,
  AutomationMap,
  ChannelSource,
  DeckLoop,
  FilterKind,
  PatchSpec,
  SceneSpec,
  StageResult,
  VideoPlayback,
} from '../types';

const SLOTS = 8;
const CHANNELS = 4;
const FALLBACK_ASPECT = 16 / 9;
const FLUSH_MS = 16;

interface ViewCanvases {
  a?: HTMLCanvasElement | null;
  b?: HTMLCanvasElement | null;
}

interface FramePayload {
  kind: 'preview' | 'scene';
  channel?: number;
  scene?: number;
  jpegBase64: string;
}

interface SpriteMeta {
  width: number;
  height: number;
}

interface VideoMeta {
  width: number;
  height: number;
  durationS: number;
}

interface LandscapeMeta {
  span: number;
  camHeight: number;
}

interface SlotState {
  mix: number;
  scale: number;
  sizeX: number;
  sizeY: number;
  tilt: number;
  contrast: number;
  hue: number;
  sat: number;
  layer: number;
  posX: number;
  posY: number;
  brightness: number;
  lightAngle: number;
  band: AudioBand;
  amt: number;
  tile: boolean;
  aut: AutomationMap;
  filter: SlotFilter;
  loop: DeckLoop | null;
  video?: VideoPlayback | null;
}

interface SlotFilter {
  kind: FilterKind;
  amount: number;
  param2: number;
}

const emptyAut = (): AutomationMap => ({
  scl: { amt: 0, audio: false },
  rot: { amt: 0, audio: false },
  tlt: { amt: 0, audio: false },
  flk: { amt: 0, audio: false },
  dst: { amt: 0, audio: false },
  skw: { amt: 0, audio: false },
});

const defaultSlot = (): SlotState => ({
  mix: 0,
  scale: 1,
  sizeX: 1,
  sizeY: 1,
  tilt: 0,
  contrast: 1,
  hue: 0,
  sat: 1,
  layer: 4,
  posX: 0,
  posY: 0,
  brightness: 1,
  lightAngle: 0,
  band: 'level',
  amt: 1,
  tile: true,
  aut: emptyAut(),
  filter: { kind: 'none', amount: 0.5, param2: 0.5 },
  loop: null,
  video: null,
});

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
};

export class NativeRenderEngine {
  private views: { a: HTMLCanvasElement | null; b: HTMLCanvasElement | null };
  private previewCanvases: (HTMLCanvasElement | null)[];

  private slots: SlotState[];
  private sources: ChannelSource[];
  private patches: PatchSpec[];
  private xfade = 0;
  private cueScene = 0;
  private bpm = 120;
  // Optional master render-resolution cap (0 = uncapped). Stretched to the
  // output surface by the native present blit — a perf lever for weak GPUs.
  private renderMaxW = 0;
  private renderMaxH = 0;

  private running = true;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private unlistens: UnlistenFn[] = [];
  private masterClosedCbs: Array<() => void> = [];
  private textureShareCbs: Array<(on: boolean) => void> = [];
  private glowCbs: Array<(on: boolean) => void> = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(viewCanvases: ViewCanvases, previewCanvases: (HTMLCanvasElement | null)[]) {
    this.views = { a: viewCanvases.a ?? null, b: viewCanvases.b ?? null };
    this.previewCanvases = previewCanvases;
    this.slots = Array.from({ length: SLOTS }, defaultSlot);
    this.patches = [...DEFAULT_DECK_PATCHES];
    this.sources = this.patches.map((patch) => ({ type: 'shader', patch }));

    invoke('render_start').catch((err) =>
      console.error('[Vizzy] Native render engine failed to start:', err),
    );
    this.subscribe();
    this.markDirty();

    // the deck aspect follows the A view; push state when it resizes
    if (typeof ResizeObserver !== 'undefined' && this.views.a) {
      this.resizeObserver = new ResizeObserver(() => this.markDirty());
      this.resizeObserver.observe(this.views.a);
    }
  }

  /** Re-point the scene monitors at a different pair of canvases. Used when the
   *  app swaps between the studio layout and the full-screen performance layout
   *  — each owns its own canvas elements, but there is one engine. The deck
   *  aspect follows the new A view, so keep A at the intended output aspect. */
  setViewCanvases(views: ViewCanvases): void {
    this.views = { a: views.a ?? null, b: views.b ?? null };
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined' && this.views.a) {
      this.resizeObserver = new ResizeObserver(() => this.markDirty());
      this.resizeObserver.observe(this.views.a);
    }
    this.markDirty();
  }

  private subscribe(): void {
    const add = (p: Promise<UnlistenFn>) =>
      p.then((fn) => {
        if (this.running) this.unlistens.push(fn);
        else fn();
      });
    add(listen<FramePayload>('vizzy://render-frame', (e) => this.drawFrame(e.payload)));
    add(
      listen('vizzy://render-master-closed', () => {
        this.masterClosedCbs.forEach((cb) => cb());
      }),
    );
    add(
      listen<{ on: boolean }>('vizzy://texture-share', (e) => {
        this.textureShareCbs.forEach((cb) => cb(e.payload.on));
      }),
    );
    add(
      listen<{ on: boolean }>('vizzy://glow', (e) => {
        this.glowCbs.forEach((cb) => cb(e.payload.on));
      }),
    );
  }

  private drawFrame(frame: FramePayload): void {
    const canvas =
      frame.kind === 'preview'
        ? this.previewCanvases[frame.channel ?? 0]
        : frame.scene === 0
          ? this.views.a
          : this.views.b;
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      if (frame.kind === 'preview') {
        // previews adopt the streamed frame's size — they're thumbnail-scale
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        ctx.drawImage(img, 0, 0);
        return;
      }
      // monitors contain-fit with black letterboxing, like renderToView did
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(canvas.clientWidth * dpr) || img.width;
      const ph = Math.round(canvas.clientHeight * dpr) || img.height;
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const fit = Math.min(pw / img.width, ph / img.height);
      const dw = Math.round(img.width * fit);
      const dh = Math.round(img.height * fit);
      if (dw !== pw || dh !== ph) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, pw, ph);
      }
      ctx.drawImage(img, Math.round((pw - dw) / 2), Math.round((ph - dh) / 2), dw, dh);
    };
    img.src = `data:image/jpeg;base64,${frame.jpegBase64}`;
  }

  // ---- state mirror: setters mark dirty, one coalesced push per ~frame ----

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flush();
    }, FLUSH_MS);
  }

  /** Build the render_state payload; exposed for tests. */
  statePayload() {
    const a = this.views.a;
    const aspect =
      a && a.clientWidth > 0 && a.clientHeight > 0
        ? a.clientWidth / a.clientHeight
        : FALLBACK_ASPECT;
    return {
      aspect,
      xfade: this.xfade,
      cueScene: this.cueScene,
      bpm: this.bpm,
      slots: this.slots,
      renderMaxW: this.renderMaxW,
      renderMaxH: this.renderMaxH,
    };
  }

  private flush(): void {
    this.dirty = false;
    invoke('render_state', { state: this.statePayload() }).catch(() => {});
  }

  setOpacity(deckIndex: number, value: number): void {
    this.slots[deckIndex].mix = value;
    this.markDirty();
  }

  setScale(deckIndex: number, value: number): void {
    this.slots[deckIndex].scale = value;
    this.markDirty();
  }

  setSize(deckIndex: number, x: number, y: number): void {
    this.slots[deckIndex].sizeX = x;
    this.slots[deckIndex].sizeY = y;
    this.markDirty();
  }

  setCrossfade(value: number): void {
    this.xfade = value;
    this.markDirty();
  }

  // tilt and hue in radians
  setChannelFx(deckIndex: number, tilt: number, contrast: number, hue: number, sat: number): void {
    const s = this.slots[deckIndex];
    s.tilt = tilt;
    s.contrast = contrast;
    s.hue = hue;
    s.sat = sat;
    this.markDirty();
  }

  setAudioRouting(deckIndex: number, band: AudioBand, amt: number): void {
    this.slots[deckIndex].band = band;
    this.slots[deckIndex].amt = amt;
    this.markDirty();
  }

  setVideoPlayback(deckIndex: number, playback: VideoPlayback): void {
    this.slots[deckIndex].video = playback;
    this.markDirty();
  }

  setFilter(deckIndex: number, kind: FilterKind, amount: number, param2: number): void {
    this.slots[deckIndex].filter = { kind, amount, param2 };
    this.markDirty();
  }

  setCueScene(sceneIndex: number): void {
    this.cueScene = sceneIndex;
    this.markDirty();
  }

  setAutomation(deckIndex: number, aut: AutomationMap): void {
    this.slots[deckIndex].aut = aut;
    this.markDirty();
  }

  setPosition(deckIndex: number, x: number, y: number): void {
    this.slots[deckIndex].posX = x;
    this.slots[deckIndex].posY = y;
    this.markDirty();
  }

  setLighting(deckIndex: number, brightness: number, angle: number): void {
    this.slots[deckIndex].brightness = brightness;
    this.slots[deckIndex].lightAngle = angle;
    this.markDirty();
  }

  setLayer(deckIndex: number, layer: number): void {
    this.slots[deckIndex].layer = layer;
    this.markDirty();
  }

  // Mirror-tile the content to fill the frame when scaled (true = default look);
  // false shows a single scaled copy. Only meaningful for sprite/video/model.
  setTile(deckIndex: number, value: boolean): void {
    this.slots[deckIndex].tile = value;
    this.markDirty();
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
    this.markDirty();
  }

  /** Cap the master render resolution (px). Pass (0, 0) to render at native
   *  output size. The engine preserves aspect and stretches to the surface. */
  setRenderCap(width: number, height: number): void {
    this.renderMaxW = Math.max(0, Math.round(width));
    this.renderMaxH = Math.max(0, Math.round(height));
    this.markDirty();
  }

  setLoop(deckIndex: number, loop: DeckLoop | null): void {
    this.slots[deckIndex].loop = loop;
    this.markDirty();
  }

  /** Master out is a native window; there is no canvas to attach. */
  setMasterCanvas(_canvas: HTMLCanvasElement | null): void {}

  // ---- staging ----

  async stagePatch(deckIndex: number, patch: PatchSpec): Promise<StageResult> {
    try {
      await invoke('render_stage_patch', { slot: deckIndex, spec: patch });
      this.patches[deckIndex] = patch;
      this.sources[deckIndex] = { type: 'shader', patch };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  async stageSpriteFromPath(
    deckIndex: number,
    path: string,
    spriteId: string,
  ): Promise<StageResult> {
    try {
      await invoke<SpriteMeta>('render_stage_sprite', { slot: deckIndex, path });
      this.sources[deckIndex] = { type: 'sprite', spriteId };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  async stageVideoFromPath(
    deckIndex: number,
    path: string,
    videoId: string,
  ): Promise<StageResult> {
    try {
      await invoke<VideoMeta>('render_stage_video', { slot: deckIndex, path });
      this.sources[deckIndex] = { type: 'video', videoId };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  async stageModelFromPath(
    deckIndex: number,
    path: string,
    modelId: string,
  ): Promise<StageResult> {
    try {
      await invoke('render_stage_model', { slot: deckIndex, path });
      this.sources[deckIndex] = { type: 'model', modelId };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  async stageLandscapeFromPath(
    deckIndex: number,
    path: string,
    modelId: string,
  ): Promise<StageResult> {
    try {
      await invoke<LandscapeMeta>('render_stage_landscape', { slot: deckIndex, path });
      this.sources[deckIndex] = { type: 'landscape', modelId };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  async stageSceneSpec(deckIndex: number, spec: SceneSpec): Promise<StageResult> {
    try {
      const { positions, colors, indices } = buildSceneBuffers(spec);
      await invoke<LandscapeMeta>('render_stage_scene', {
        slot: deckIndex,
        positions,
        colors,
        indices,
        fly: spec.kind === 'tunnel' ? 'through' : 'over',
        fogColor: hexToRgb(spec.palette[2]),
      });
      this.sources[deckIndex] = { type: 'scene', spec };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  resetAllDecks(): void {
    DEFAULT_DECK_PATCHES.forEach((patch, i) => {
      void this.stagePatch(i, patch);
    });
  }

  // ---- introspection (used by library save flows) ----

  getPatch(deckIndex: number): PatchSpec {
    return this.patches[deckIndex];
  }

  getChannelSource(deckIndex: number): ChannelSource {
    return this.sources[deckIndex];
  }

  getPreviewDataURL(channelIndex: number): string | null {
    const canvas = this.previewCanvases[channelIndex];
    return canvas && canvas.width > 0 ? canvas.toDataURL('image/jpeg', 0.75) : null;
  }

  getSceneDataURL(sceneIndex: number): string | null {
    const src = sceneIndex === 0 ? this.views.a : this.views.b;
    if (!src || src.width === 0 || src.height === 0) return null;
    const thumb = document.createElement('canvas');
    thumb.width = 160;
    thumb.height = Math.max(1, Math.round((160 * src.height) / src.width));
    thumb.getContext('2d')!.drawImage(src, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL('image/jpeg', 0.75);
  }

  // ---- native master window ----

  async openMaster(): Promise<boolean> {
    return invoke<boolean>('render_master', { open: true });
  }

  async closeMaster(): Promise<boolean> {
    return invoke<boolean>('render_master', { open: false });
  }

  async setMasterFullscreen(on: boolean): Promise<void> {
    await invoke('render_master_fullscreen', { on });
  }

  onMasterClosed(cb: () => void): void {
    this.masterClosedCbs.push(cb);
  }

  // ---- texture sharing (Syphon on macOS, Spout on Windows) ----

  /** Toggle sharing the master composite with other VJ apps. Resolves to the
   *  resulting share state; rejects on unsupported platforms or GPU failure. */
  async setTextureShare(on: boolean): Promise<boolean> {
    return invoke<boolean>('render_texture_share', { on });
  }

  onTextureShare(cb: (on: boolean) => void): void {
    this.textureShareCbs.push(cb);
  }

  // ---- master glow (bloom) ----

  /** Toggle the bloom post chain on the master output. Resolves to the
   *  resulting glow state. */
  async setGlow(on: boolean): Promise<boolean> {
    return invoke<boolean>('render_glow', { on });
  }

  onGlow(cb: (on: boolean) => void): void {
    this.glowCbs.push(cb);
  }

  dispose(): void {
    this.running = false;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.resizeObserver?.disconnect();
    this.unlistens.forEach((fn) => fn());
    this.unlistens = [];
    this.masterClosedCbs = [];
    this.textureShareCbs = [];
    this.glowCbs = [];
  }
}

export { CHANNELS };
