// Tauri-native render client: the wgpu engine in src-tauri/src/render owns
// the GPU; this class keeps RenderEngine's public surface and its per-frame
// parameter evaluation (loops, AUT, audio routing — reusing the same TS
// modules), ships the final slot uniforms over IPC once per frame, and draws
// the streamed preview/monitor JPEGs onto the existing canvases.
//
// Non-shader decks (Phase 3) follow the same split: the deck's scene-graph
// state lives here as HEADLESS three.js objects (Group/Camera math only, no
// GL), the existing automation functions mutate them each frame, and the
// resulting transforms ship in the params payload's per-deck ext block.
import * as THREE from 'three';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { DEFAULT_DECK_BODIES } from './shaders';
import {
  animateModelDeck,
  animateSpriteDeck,
  animateLandscapeDeck,
  animateShaderComposite,
  pinCompositeToBase,
} from './automation';
import { sampleLane } from '../lib/loopControls';
import { buildSceneObject } from '../lib/sceneGenerator';
import type {
  LandscapeDeckContent,
  ModelDeckContent,
  SlotBaseParams,
  SlotUniforms,
  SpriteDeckContent,
} from './types';
import type {
  AudioBand,
  AutomationMap,
  ChannelSource,
  DeckLoop,
  SceneSpec,
  StageResult,
} from '../types';
import type { AudioAnalyser } from './RenderEngine';

const SLOTS = 8;
const SLOT_FLOATS = 15;
const EXT_FLOATS = 16;
const CHANNELS = 4;
const FALLBACK_ASPECT = 16 / 9;
const FLIGHT_FOV = 64; // stageTiledFlight's camera

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

interface LandscapeMeta {
  span: number;
  camHeight: number;
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

// Headless stand-ins for the deck content the automation functions animate.
// They satisfy exactly the fields each animate* touches (asserted by casts at
// the call sites) without renderers, materials with real shaders, or rigs —
// lighting travels as brightness/angle floats, the Rust side owns the rig.
interface NativeSprite {
  container: THREE.Group;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  spriteId: string;
  imageAspect: number;
  baseW: number;
  baseH: number;
  spin: number;
}

interface NativeModel {
  group: THREE.Group;
  modelId: string;
  baseScale: number;
  spin: number;
}

interface NativeFlight {
  scene: THREE.Scene;
  tiles: [THREE.Group, THREE.Group];
  camera: THREE.PerspectiveCamera;
  fly: 'over' | 'through';
  span: number;
  camHeight: number;
  scroll: number;
}

type NativeContent =
  | { kind: 'shader' }
  | { kind: 'sprite'; data: NativeSprite }
  | { kind: 'model'; data: NativeModel }
  | { kind: 'flight'; data: NativeFlight };

const emptyAut = (): AutomationMap => ({
  scl: { amt: 0, audio: false },
  rot: { amt: 0, audio: false },
  tlt: { amt: 0, audio: false },
  flk: { amt: 0, audio: false },
  dst: { amt: 0, audio: false },
  skw: { amt: 0, audio: false },
});

const hexToRgb = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** positions/colors/indices of the single mesh inside a generated group. */
function extractMeshBuffers(object: THREE.Object3D): {
  positions: number[];
  colors: number[];
  indices: number[];
} {
  let geometry: THREE.BufferGeometry | null = null;
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!geometry && mesh.isMesh) geometry = mesh.geometry;
  });
  if (!geometry) throw new Error('Scene mesh is empty');
  const g: THREE.BufferGeometry = geometry;
  const positions = Array.from(g.getAttribute('position').array as Float32Array);
  const colorAttr = g.getAttribute('color');
  const colors = colorAttr
    ? Array.from(colorAttr.array as Float32Array)
    : new Array((positions.length / 3) * 3).fill(1);
  const indices = g.index ? Array.from(g.index.array) : [];
  return { positions, colors, indices };
}

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
  private contents: NativeContent[];
  private sources: ChannelSource[];
  private bodies: string[];
  private xfade = 0;
  private cueScene = 0;
  private bpm = 120;

  private raf = 0;
  private running = true;
  private startTime = performance.now();
  private lastFrameTime: number | null = null;
  private slots = new Float32Array(SLOTS * SLOT_FLOATS);
  private decks = new Float32Array(SLOTS * EXT_FLOATS);
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
    this.contents = Array.from({ length: SLOTS }, () => ({ kind: 'shader' as const }));
    this.bodies = [...DEFAULT_DECK_BODIES];
    this.sources = this.bodies.map((code) => ({ type: 'shader', code }));

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
      this.contents[deckIndex] = { kind: 'shader' };
      this.sources[deckIndex] = { type: 'shader', code: body };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  /** Sprite from an image file path (native decode + upload in the core). */
  async stageSpriteFromPath(
    deckIndex: number,
    path: string,
    spriteId: string,
  ): Promise<StageResult> {
    try {
      const meta = await invoke<SpriteMeta>('render_stage_sprite', { slot: deckIndex, path });
      // material exists only as a uniforms carrier for animateSpriteDeck
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.ShaderMaterial({
          uniforms: {
            u_time: { value: 0 },
            u_opacity: { value: 1 },
            u_distort: { value: 0 },
            u_skew: { value: 0 },
          },
        }),
      );
      const container = new THREE.Group();
      container.add(mesh);
      this.contents[deckIndex] = {
        kind: 'sprite',
        data: {
          container,
          mesh,
          spriteId,
          imageAspect: meta.width / Math.max(1, meta.height),
          baseW: 1,
          baseH: 1,
          spin: 0,
        },
      };
      this.sources[deckIndex] = { type: 'sprite', spriteId };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  /** 3D model from a file path (.glb/.gltf/.obj/.stl — native load). */
  async stageModelFromPath(
    deckIndex: number,
    path: string,
    modelId: string,
  ): Promise<StageResult> {
    try {
      await invoke('render_stage_model', { slot: deckIndex, path });
      this.contents[deckIndex] = {
        kind: 'model',
        // the core bakes normalization into the geometry; TS animates around 1
        data: { group: new THREE.Group(), modelId, baseScale: 1, spin: 0 },
      };
      this.sources[deckIndex] = { type: 'model', modelId };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  /** Model file as endless fly-over terrain. */
  async stageLandscapeFromPath(
    deckIndex: number,
    path: string,
    modelId: string,
  ): Promise<StageResult> {
    try {
      const meta = await invoke<LandscapeMeta>('render_stage_landscape', {
        slot: deckIndex,
        path,
      });
      this.contents[deckIndex] = {
        kind: 'flight',
        data: this.makeFlight('over', meta),
      };
      this.sources[deckIndex] = { type: 'landscape', modelId };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  /** Procedural scene: same signature as RenderEngine's (object pre-built). */
  async stageScene(
    deckIndex: number,
    object3D: THREE.Object3D,
    spec: SceneSpec,
  ): Promise<StageResult> {
    try {
      const { positions, colors, indices } = extractMeshBuffers(object3D);
      const fly = spec.kind === 'tunnel' ? 'through' : 'over';
      const meta = await invoke<LandscapeMeta>('render_stage_scene', {
        slot: deckIndex,
        positions,
        colors,
        indices,
        fly,
        fogColor: hexToRgb(spec.palette[2]),
      });
      this.contents[deckIndex] = { kind: 'flight', data: this.makeFlight(fly, meta) };
      this.sources[deckIndex] = { type: 'scene', spec };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: typeof err === 'string' ? err : String(err) };
    }
  }

  /** Convenience for session/library restore paths. */
  stageSceneSpec(deckIndex: number, spec: SceneSpec): Promise<StageResult> {
    return this.stageScene(deckIndex, buildSceneObject(spec), spec);
  }

  private makeFlight(fly: 'over' | 'through', meta: LandscapeMeta): NativeFlight {
    const scene = new THREE.Scene();
    const tiles: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
    tiles.forEach((tile) => scene.add(tile));
    const camera = new THREE.PerspectiveCamera(FLIGHT_FOV, 16 / 9, 0.05, meta.span * 2.5);
    // animate only steers x/y — z is fixed at the staged vantage
    camera.position.set(0, meta.camHeight, meta.span * 0.45);
    return {
      scene,
      tiles,
      camera,
      fly,
      span: meta.span,
      camHeight: meta.camHeight,
      scroll: 0,
    };
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

  // ---- per-frame parameter evaluation (ported from RenderEngine.loop) ----

  private applyLoopOverrides(
    deckIndex: number,
    loop: DeckLoop,
    phase: number,
  ): { base: SlotBaseParams; pos: { x: number; y: number }; light: { brightness: number; angle: number } } {
    const knobBase = this.baseParams[deckIndex];
    const knobPos = this.positions[deckIndex];
    const knobLight = this.lighting[deckIndex];
    const base: SlotBaseParams = {
      mix: knobBase.mix,
      scale: knobBase.scale,
      size: { x: knobBase.size.x, y: knobBase.size.y },
      fx: knobBase.fx.clone(),
    };
    const pos = { x: knobPos.x, y: knobPos.y };
    const light = { brightness: knobLight.brightness, angle: knobLight.angle };

    const lane = (id: keyof DeckLoop['lanes']): number | null => {
      const points = loop.lanes[id];
      return points ? sampleLane(points, phase) : null;
    };
    const lerp = (lo: number, hi: number, v: number) => lo + (hi - lo) * v;

    const opacity = lane('opacity');
    if (opacity !== null) base.mix = knobBase.mix * opacity; // fader lane multiplies: mute wins
    const scale = lane('scale');
    if (scale !== null) base.scale = lerp(0.25, 3, scale);
    const sizeX = lane('sizeX');
    if (sizeX !== null) base.size.x = lerp(0.05, 1, sizeX);
    const sizeY = lane('sizeY');
    if (sizeY !== null) base.size.y = lerp(0.05, 1, sizeY);
    const posX = lane('posX');
    if (posX !== null) pos.x = lerp(-2, 2, posX);
    const posY = lane('posY');
    if (posY !== null) pos.y = lerp(-2, 2, posY);
    const tilt = lane('tilt');
    if (tilt !== null) base.fx.x = lerp(-Math.PI, Math.PI, tilt);
    const contrast = lane('contrast');
    if (contrast !== null) base.fx.y = lerp(0, 2, contrast);
    const hue = lane('hue');
    if (hue !== null) base.fx.z = lerp(-Math.PI, Math.PI, hue);
    const sat = lane('sat');
    if (sat !== null) base.fx.w = lerp(0, 2, sat);
    const brightness = lane('brightness');
    if (brightness !== null) light.brightness = lerp(0, 2, brightness);
    const lightAngle = lane('lightAngle');
    if (lightAngle !== null) light.angle = lerp(-Math.PI, Math.PI, lightAngle);

    return { base, pos, light };
  }

  // The sprite container compensates the view aspect outside the mesh's
  // rotation, exactly like RenderEngine.updateSpriteLayout.
  private layoutSprite(sprite: NativeSprite, viewAspect: number): void {
    sprite.container.scale.set(1 / viewAspect, 1, 1);
    const h = Math.min(1.7, (1.7 * viewAspect) / sprite.imageAspect);
    sprite.baseW = h * sprite.imageAspect;
    sprite.baseH = h;
  }

  private writeExt(slot: number, values: number[]): void {
    const o = slot * EXT_FLOATS;
    this.decks.fill(0, o, o + EXT_FLOATS);
    for (let i = 0; i < values.length; i += 1) this.decks[o + i] = values[i];
  }

  /** One evaluation tick; exposed for tests. Returns [slots, decks]. */
  frame(t: number, dt: number, viewAspect = FALLBACK_ASPECT): [Float32Array, Float32Array] {
    const audio = this.audioEngine?.update() ?? { low: 0, mid: 0, high: 0, level: 0 };
    for (let i = 0; i < SLOTS; i += 1) {
      const route = this.audioRouting[i];
      const low = Math.min(1, audio.low * route.amt);
      const mid = Math.min(1, audio.mid * route.amt);
      const high = Math.min(1, audio.high * route.amt);
      const level = Math.min(1, (audio[route.band] ?? audio.level) * route.amt);

      let base = this.baseParams[i];
      let pos = this.positions[i];
      let light = this.lighting[i];
      const loop = this.loops[i];
      if (loop?.playing) {
        const beats = Math.max(0.125, loop.blocks * loop.divider);
        const phase = ((t * this.bpm) / 60 / beats) % 1;
        ({ base, pos, light } = this.applyLoopOverrides(i, loop, phase));
      }

      const content = this.contents[i];
      const uniforms = this.slotUniforms[i] as unknown as SlotUniforms;
      if (content.kind === 'shader') {
        animateShaderComposite(uniforms, base, this.compositeSpin[i], this.automation[i], level, t, dt);
        this.writeExt(i, [0]);
      } else {
        pinCompositeToBase(uniforms, base, this.automation[i], level, t);
        if (content.kind === 'sprite') {
          const s = content.data;
          this.layoutSprite(s, viewAspect);
          animateSpriteDeck(s as unknown as SpriteDeckContent, this.automation[i], level, t, dt, pos);
          // compose container (non-uniform aspect comp) × rotation × scale
          // into one 2×2 + translation acting on the unit quad
          const cx = s.container.scale.x;
          const cos = Math.cos(s.mesh.rotation.z);
          const sin = Math.sin(s.mesh.rotation.z);
          const sx = s.mesh.scale.x;
          const sy = s.mesh.scale.y;
          const u = s.mesh.material.uniforms;
          this.writeExt(i, [
            1,
            cx * cos * sx,
            cx * -sin * sy,
            sin * sx,
            cos * sy,
            cx * s.mesh.position.x,
            s.mesh.position.y,
            u.u_distort.value as number,
            u.u_skew.value as number,
            u.u_opacity.value as number,
            1, // sprites blink via opacity, not visibility
          ]);
        } else if (content.kind === 'model') {
          const m = content.data;
          animateModelDeck(m as unknown as ModelDeckContent, this.automation[i], level, t, dt, pos);
          const g = m.group;
          this.writeExt(i, [
            2,
            g.position.x,
            g.position.y,
            g.position.z,
            g.quaternion.x,
            g.quaternion.y,
            g.quaternion.z,
            g.quaternion.w,
            g.scale.x,
            light.brightness,
            light.angle,
            g.visible ? 1 : 0,
            g.scale.y,
            g.scale.z,
          ]);
        } else {
          const f = content.data;
          animateLandscapeDeck(
            f as unknown as LandscapeDeckContent,
            this.automation[i],
            level,
            t,
            dt,
            pos,
          );
          const cam = f.camera;
          this.writeExt(i, [
            3,
            cam.position.x,
            cam.position.y,
            cam.position.z,
            cam.quaternion.x,
            cam.quaternion.y,
            cam.quaternion.z,
            cam.quaternion.w,
            f.tiles[0].position.z,
            f.tiles[1].position.z,
            f.tiles[0].scale.y,
            light.brightness,
            light.angle,
            f.scene.visible ? 1 : 0,
            FLIGHT_FOV,
          ]);
        }
      }

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
    return [this.slots, this.decks];
  }

  private loop(): void {
    if (!this.running) return;
    const t = (performance.now() - this.startTime) / 1000;
    const dt = Math.min(0.1, t - (this.lastFrameTime ?? t));
    this.lastFrameTime = t;

    const a = this.views.a;
    const aspect =
      a && a.clientWidth > 0 && a.clientHeight > 0
        ? a.clientWidth / a.clientHeight
        : FALLBACK_ASPECT;
    const [slots, decks] = this.frame(t, dt, aspect);

    invoke('render_params', {
      params: {
        aspect,
        xfade: this.xfade,
        cueScene: this.cueScene,
        slots: Array.from(slots),
        decks: Array.from(decks),
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
