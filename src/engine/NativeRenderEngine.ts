// Tauri-native render client: the wgpu engine in src-tauri/src/render owns
// the GPU; this class keeps RenderEngine's public surface and its per-frame
// parameter evaluation (loops, AUT, audio routing — reusing the same TS
// modules), ships the final slot uniforms over IPC once per frame, and draws
// the streamed preview/monitor JPEGs onto the existing canvases.
//
// Phase 2 scope: every deck is a shader deck. Model/sprite/landscape/scene
// staging returns a friendly error until Phase 3 ports them.
import * as THREE from 'three';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { DEFAULT_DECK_BODIES } from './shaders';
import { animateShaderComposite } from './automation';
import { sampleLane } from '../lib/loopControls';
import type { SlotBaseParams, SlotUniforms } from './types';
import type {
  AudioBand,
  AutomationMap,
  ChannelSource,
  DeckLoop,
  StageResult,
} from '../types';
import type { AudioAnalyser } from './RenderEngine';

const SLOTS = 8;
const SLOT_FLOATS = 15;
const CHANNELS = 4;
const FALLBACK_ASPECT = 16 / 9;

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

// AUT modulates THREE-style uniform holders; reuse the exact structures so
// animateShaderComposite runs unchanged.
interface NativeSlotUniforms {
  mix: { value: number };
  scale: { value: number };
  size: { value: THREE.Vector2 };
  fx: { value: THREE.Vector4 };
  warp: { value: THREE.Vector2 };
  layer: { value: number };
}

const emptyAut = (): AutomationMap => ({
  scl: { amt: 0, audio: false },
  rot: { amt: 0, audio: false },
  tlt: { amt: 0, audio: false },
  flk: { amt: 0, audio: false },
  dst: { amt: 0, audio: false },
  skw: { amt: 0, audio: false },
});

export class NativeRenderEngine {
  audioEngine: AudioAnalyser | null;
  private views: { a: HTMLCanvasElement | null; b: HTMLCanvasElement | null };
  private previewCanvases: (HTMLCanvasElement | null)[];

  private baseParams: SlotBaseParams[];
  private slotUniforms: NativeSlotUniforms[];
  private positions: { x: number; y: number }[];
  private lighting: { brightness: number; angle: number }[];
  private loops: (DeckLoop | null)[];
  private automation: AutomationMap[];
  private audioRouting: { band: AudioBand; amt: number }[];
  private compositeSpin: { spin: number }[];
  private bodies: string[];
  private xfade = 0;
  private cueScene = 0;
  private bpm = 120;

  private raf = 0;
  private running = true;
  private startTime = performance.now();
  private lastFrameTime: number | null = null;
  private slots = new Float32Array(SLOTS * SLOT_FLOATS);
  private unlistens: UnlistenFn[] = [];
  private masterClosedCbs: Array<() => void> = [];

  constructor(
    viewCanvases: ViewCanvases,
    previewCanvases: (HTMLCanvasElement | null)[],
    audioEngine: AudioAnalyser | null,
  ) {
    this.audioEngine = audioEngine;
    this.views = { a: viewCanvases.a ?? null, b: viewCanvases.b ?? null };
    this.previewCanvases = previewCanvases;

    this.baseParams = Array.from({ length: SLOTS }, () => ({
      mix: 0,
      scale: 1,
      size: { x: 1, y: 1 },
      fx: new THREE.Vector4(0, 1, 0, 1),
    }));
    this.slotUniforms = Array.from({ length: SLOTS }, () => ({
      mix: { value: 0 },
      scale: { value: 1 },
      size: { value: new THREE.Vector2(1, 1) },
      fx: { value: new THREE.Vector4(0, 1, 0, 1) },
      warp: { value: new THREE.Vector2(0, 0) },
      layer: { value: 4 },
    }));
    this.positions = Array.from({ length: SLOTS }, () => ({ x: 0, y: 0 }));
    this.lighting = Array.from({ length: SLOTS }, () => ({ brightness: 1, angle: 0 }));
    this.loops = Array.from({ length: SLOTS }, () => null);
    this.automation = Array.from({ length: SLOTS }, emptyAut);
    this.audioRouting = Array.from({ length: SLOTS }, () => ({
      band: 'level' as AudioBand,
      amt: 1,
    }));
    this.compositeSpin = Array.from({ length: SLOTS }, () => ({ spin: 0 }));
    this.bodies = [...DEFAULT_DECK_BODIES];

    invoke('render_start').catch((err) =>
      console.error('[Vizzy] Native render engine failed to start:', err),
    );
    this.subscribe();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  private subscribe(): void {
    const add = (p: Promise<UnlistenFn>) =>
      p.then((fn) => {
        if (this.running) this.unlistens.push(fn);
        else fn();
      });
    add(
      listen<FramePayload>('vizzy://render-frame', (e) => this.drawFrame(e.payload)),
    );
    add(
      listen('vizzy://render-master-closed', () => {
        this.masterClosedCbs.forEach((cb) => cb());
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

  // ---- knob setters: same semantics as RenderEngine ----

  setOpacity(deckIndex: number, value: number): void {
    this.baseParams[deckIndex].mix = value;
  }

  setScale(deckIndex: number, value: number): void {
    this.baseParams[deckIndex].scale = value;
  }

  setSize(deckIndex: number, x: number, y: number): void {
    this.baseParams[deckIndex].size = { x, y };
  }

  setCrossfade(value: number): void {
    this.xfade = value;
  }

  // tilt and hue in radians
  setChannelFx(deckIndex: number, tilt: number, contrast: number, hue: number, sat: number): void {
    this.baseParams[deckIndex].fx.set(tilt, contrast, hue, sat);
  }

  setAudioRouting(deckIndex: number, band: AudioBand, amt: number): void {
    this.audioRouting[deckIndex] = { band, amt };
  }

  setCueScene(sceneIndex: number): void {
    this.cueScene = sceneIndex;
  }

  setAutomation(deckIndex: number, aut: AutomationMap): void {
    this.automation[deckIndex] = aut;
  }

  setPosition(deckIndex: number, x: number, y: number): void {
    this.positions[deckIndex] = { x, y };
  }

  setLighting(deckIndex: number, brightness: number, angle: number): void {
    this.lighting[deckIndex] = { brightness, angle };
  }

  setLayer(deckIndex: number, layer: number): void {
    this.slotUniforms[deckIndex].layer.value = layer;
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
  }

  setLoop(deckIndex: number, loop: DeckLoop | null): void {
    this.loops[deckIndex] = loop;
  }

  /** Master out is a native window; there is no canvas to attach. */
  setMasterCanvas(_canvas: HTMLCanvasElement | null): void {}

  // ---- staging ----

  async stageShader(deckIndex: number, body: string): Promise<StageResult> {
    try {
      await invoke('render_stage_shader', { slot: deckIndex, body });
      this.bodies[deckIndex] = body;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  private phase3Stub(): StageResult {
    return {
      ok: false,
      error: 'Model, sprite and scene decks return with the native renderer (Phase 3).',
    };
  }

  stageSprite(): StageResult {
    return this.phase3Stub();
  }

  async stageModel(): Promise<StageResult> {
    return this.phase3Stub();
  }

  async stageLandscape(): Promise<StageResult> {
    return this.phase3Stub();
  }

  async stageScene(): Promise<StageResult> {
    return this.phase3Stub();
  }

  resetAllDecks(): void {
    DEFAULT_DECK_BODIES.forEach((body, i) => {
      void this.stageShader(i, body);
      this.compositeSpin[i].spin = 0;
    });
  }

  // ---- introspection (used by library save flows) ----

  getShaderBody(deckIndex: number): string {
    return this.bodies[deckIndex];
  }

  getChannelSource(deckIndex: number): ChannelSource {
    return { type: 'shader', code: this.bodies[deckIndex] };
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

  // ---- per-frame parameter evaluation (ported from RenderEngine.loop) ----

  private applyLoopOverrides(
    deckIndex: number,
    loop: DeckLoop,
    phase: number,
  ): SlotBaseParams {
    const base = this.baseParams[deckIndex];
    const out: SlotBaseParams = {
      mix: base.mix,
      scale: base.scale,
      size: { x: base.size.x, y: base.size.y },
      fx: base.fx.clone(),
    };
    const lane = (id: keyof DeckLoop['lanes']): number | null => {
      const points = loop.lanes[id];
      return points ? sampleLane(points, phase) : null;
    };
    const lerp = (lo: number, hi: number, v: number) => lo + (hi - lo) * v;

    const opacity = lane('opacity');
    if (opacity !== null) out.mix = base.mix * opacity; // fader lane multiplies: mute wins
    const scale = lane('scale');
    if (scale !== null) out.scale = lerp(0.25, 3, scale);
    const sizeX = lane('sizeX');
    if (sizeX !== null) out.size.x = lerp(0.05, 1, sizeX);
    const sizeY = lane('sizeY');
    if (sizeY !== null) out.size.y = lerp(0.05, 1, sizeY);
    const tilt = lane('tilt');
    if (tilt !== null) out.fx.x = lerp(-Math.PI, Math.PI, tilt);
    const contrast = lane('contrast');
    if (contrast !== null) out.fx.y = lerp(0, 2, contrast);
    const hue = lane('hue');
    if (hue !== null) out.fx.z = lerp(-Math.PI, Math.PI, hue);
    const sat = lane('sat');
    if (sat !== null) out.fx.w = lerp(0, 2, sat);
    return out;
  }

  /** One evaluation tick; exposed for tests. Returns the flat slots array. */
  frame(t: number, dt: number): Float32Array {
    const audio = this.audioEngine?.update() ?? { low: 0, mid: 0, high: 0, level: 0 };
    for (let i = 0; i < SLOTS; i += 1) {
      const route = this.audioRouting[i];
      const low = Math.min(1, audio.low * route.amt);
      const mid = Math.min(1, audio.mid * route.amt);
      const high = Math.min(1, audio.high * route.amt);
      const level = Math.min(1, (audio[route.band] ?? audio.level) * route.amt);

      let base = this.baseParams[i];
      const loop = this.loops[i];
      if (loop?.playing) {
        const beats = Math.max(0.125, loop.blocks * loop.divider);
        const phase = ((t * this.bpm) / 60 / beats) % 1;
        base = this.applyLoopOverrides(i, loop, phase);
      }

      // NativeSlotUniforms lacks the THREE texture binding SlotUniforms
      // carries; animateShaderComposite never touches it.
      animateShaderComposite(
        this.slotUniforms[i] as unknown as SlotUniforms,
        base,
        this.compositeSpin[i],
        this.automation[i],
        level,
        t,
        dt,
      );

      const u = this.slotUniforms[i];
      const o = i * SLOT_FLOATS;
      this.slots[o] = u.mix.value;
      this.slots[o + 1] = u.scale.value;
      this.slots[o + 2] = u.size.value.x;
      this.slots[o + 3] = u.size.value.y;
      this.slots[o + 4] = u.fx.value.x;
      this.slots[o + 5] = u.fx.value.y;
      this.slots[o + 6] = u.fx.value.z;
      this.slots[o + 7] = u.fx.value.w;
      this.slots[o + 8] = u.warp.value.x;
      this.slots[o + 9] = u.warp.value.y;
      this.slots[o + 10] = u.layer.value;
      this.slots[o + 11] = low;
      this.slots[o + 12] = mid;
      this.slots[o + 13] = high;
      this.slots[o + 14] = level;
    }
    return this.slots;
  }

  private loop(): void {
    if (!this.running) return;
    const t = (performance.now() - this.startTime) / 1000;
    const dt = Math.min(0.1, t - (this.lastFrameTime ?? t));
    this.lastFrameTime = t;

    const slots = this.frame(t, dt);
    const a = this.views.a;
    const aspect =
      a && a.clientWidth > 0 && a.clientHeight > 0
        ? a.clientWidth / a.clientHeight
        : FALLBACK_ASPECT;

    invoke('render_params', {
      params: {
        aspect,
        xfade: this.xfade,
        cueScene: this.cueScene,
        slots: Array.from(slots),
      },
    }).catch(() => {});

    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.unlistens.forEach((fn) => fn());
    this.unlistens = [];
    this.masterClosedCbs = [];
  }
}

export { CHANNELS };
