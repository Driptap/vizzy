import * as THREE from 'three';
import {
  VERTEX_SHADER,
  buildFragmentShader,
  DEFAULT_DECK_BODIES,
  SCENE_FRAGMENT,
  COMPOSITE_FRAGMENT,
  PREVIEW_FRAGMENT,
  SPRITE_VERTEX,
  SPRITE_FRAGMENT,
} from './shaders';
import { CHANNELS, SCENES, INITIAL_OPACITIES, makeDefaultAut } from '../lib/channels';
import { validateFragmentSource } from './glValidate';
import {
  animateLandscapeDeck,
  animateModelDeck,
  animateShaderComposite,
  animateSpriteDeck,
  applyLightRig,
  pinCompositeToBase,
} from './automation';
import { makeCompositeScene, sceneUniformSet, masterUniformSet } from './compositor';
import { flipAndPremultiply } from './preview';
import type {
  AudioBand,
  AutomationMap,
  ChannelLight,
  ChannelPos,
  ChannelSource,
  DeckLoop,
  SceneSpec,
  StageResult,
} from '../types';
import { sampleLane } from '../lib/loopControls';
import type { BlitView, Deck, DeckAudioUniforms, LightRig, SlotBaseParams, SlotUniforms } from './types';
import type { AudioEngine } from './AudioEngine';

export { CHANNELS, SCENES };

const BASE_DECK_WIDTH = 960;
// world width a landscape tile is normalized to (camera fly-over framing)
const LANDSCAPE_WIDTH = 9;
const BASE_PREVIEW_WIDTH = 160;
const FALLBACK_ASPECT = 16 / 9;
// frames the scene-view aspect must hold steady before deck targets are
// reallocated — avoids thrashing GPU memory during a window-resize drag
const ASPECT_SETTLE_FRAMES = 12;

interface ViewCanvases {
  a: HTMLCanvasElement | null;
  b: HTMLCanvasElement | null;
}

interface AudioRoute {
  band: AudioBand;
  amt: number;
}

export class RenderEngine {
  audioEngine: AudioEngine | null;
  renderer: THREE.WebGLRenderer;
  views: Record<string, BlitView>;
  shaderError: string | null;
  clock: THREE.Clock;
  camera: THREE.OrthographicCamera;
  quadGeometry: THREE.PlaneGeometry;
  spriteGeometry: THREE.PlaneGeometry;
  sharedUniforms: {
    u_time: THREE.IUniform<number>;
    u_resolution: THREE.IUniform<THREE.Vector2>;
  };
  deckAudioUniforms: DeckAudioUniforms[];
  audioRouting: AudioRoute[];
  appliedAspect: number;
  pendingAspect: number | null;
  aspectStableFrames: number;
  deckWidth: number;
  deckHeight: number;
  previewWidth: number;
  previewHeight: number;
  decks: Deck[];
  automation: AutomationMap[];
  /** in-scene content offsets (landscape camera pan/height, model/sprite shift) */
  positions: ChannelPos[];
  /** per-channel light rig controls (angle already in radians) */
  lighting: ChannelLight[];
  /** per-deck beat-locked automation loops (null = none configured) */
  loops: (DeckLoop | null)[];
  bpm: number;
  /** reused per-deck override targets so loop evaluation never allocates */
  private loopScratch: {
    base: SlotBaseParams;
    pos: ChannelPos;
    light: ChannelLight;
  }[];
  /** knob-set composite params; AUT modulates the uniforms around these */
  baseParams: SlotBaseParams[];
  /** per-deck accumulated composite spin (shader-deck ROT automation) */
  compositeSpin: { spin: number }[];
  modelCamera: THREE.PerspectiveCamera;
  slotUniforms: SlotUniforms[];
  xfadeUniform: THREE.IUniform<number>;
  aspectUniform: THREE.IUniform<number>;
  sceneComposites: THREE.Scene[];
  masterComposite: THREE.Scene;
  previewUniforms: {
    u_tex: THREE.IUniform<THREE.Texture | null>;
    u_scale: THREE.IUniform<number>;
    u_size: THREE.IUniform<THREE.Vector2>;
    u_fx: THREE.IUniform<THREE.Vector4>;
    u_warp: THREE.IUniform<THREE.Vector2>;
    u_aspect: THREE.IUniform<number>;
    u_time: THREE.IUniform<number>;
  };
  previewScene: THREE.Scene;
  cueScene: number;
  previewSlots: BlitView[];
  previewTarget: THREE.WebGLRenderTarget;
  previewBuffer: Uint8Array;
  previewImage: ImageData;
  frame: number;
  running: boolean;
  raf: number;
  lastFrameTime?: number;

  /**
   * @param viewCanvases 2D canvases the scene composites are blitted onto.
   *   The crossfaded master is attached separately via setMasterCanvas (it
   *   lives in its own pop-out window).
   * @param previewCanvases 4 deck thumbnails (cued scene)
   */
  constructor(
    viewCanvases: ViewCanvases,
    previewCanvases: (HTMLCanvasElement | null)[],
    audioEngine: AudioEngine | null,
  ) {
    this.audioEngine = audioEngine;
    // The GL canvas is never shown: one context renders every composite pass
    // and the result is blitted to the on-screen 2D view canvases (a WebGL
    // context can only present to a single canvas).
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    // alpha-0 clear: deck targets carry real per-pixel COVERAGE (a model's
    // silhouette, a sprite's transparency) for the layer compositor; the
    // additive same-layer path multiplies by alpha exactly as before.
    this.renderer.setClearColor(0x000000, 0);

    this.views = { master: { canvas: null, ctx: null } };
    Object.entries(viewCanvases).forEach(([key, canvas]) => {
      this.views[key] = {
        canvas: canvas || null,
        ctx: canvas ? canvas.getContext('2d') : null,
      };
    });

    // Captures three.js-level shader failures during the staging render so a
    // bad LLM shader is rejected instead of crashing the visuals.
    this.shaderError = null;
    this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const log =
        gl.getShaderInfoLog(fragmentShader) ||
        gl.getProgramInfoLog(program) ||
        'Unknown shader error';
      this.shaderError = log.trim();
      console.error('[Vizzy] Shader error:', this.shaderError);
    };

    this.clock = new THREE.Clock();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadGeometry = new THREE.PlaneGeometry(2, 2);

    // time/resolution are shared by reference across every deck material;
    // audio uniforms are PER DECK so each channel can route its own band and
    // response amount.
    this.sharedUniforms = {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2(1, 1) },
    };
    this.deckAudioUniforms = DEFAULT_DECK_BODIES.map(() => ({
      u_audio_low: { value: 0 },
      u_audio_mid: { value: 0 },
      u_audio_high: { value: 0 },
      u_audio_level: { value: 0 },
    }));
    // band: which global band feeds this deck's u_audio_level; amt: response
    // multiplier (applied to all four uniforms, clamped to the 0..1 contract)
    this.audioRouting = DEFAULT_DECK_BODIES.map(() => ({ band: 'level' as AudioBand, amt: 1 }));

    const viewA = this.views.a?.canvas;
    const initialAspect =
      viewA && viewA.clientWidth > 0 && viewA.clientHeight > 0
        ? viewA.clientWidth / viewA.clientHeight
        : FALLBACK_ASPECT;
    this.appliedAspect = 0;
    this.pendingAspect = null;
    this.aspectStableFrames = 0;
    this.deckWidth = BASE_DECK_WIDTH;
    this.deckHeight = Math.round(BASE_DECK_WIDTH / initialAspect);
    this.previewWidth = BASE_PREVIEW_WIDTH;
    this.previewHeight = Math.round(BASE_PREVIEW_WIDTH / initialAspect);

    const targetOptions = { depthBuffer: false, stencilBuffer: false };
    // deck targets keep a depth buffer so model decks can render real 3D
    const deckTargetOptions = { depthBuffer: true, stencilBuffer: false };

    // 8 shader slots: indices 0-3 are scene A, 4-7 are scene B. A deck is in
    // 'shader' mode (fullscreen quad) or 'model' mode (lit 3D scene); both
    // render into the same target so the composite pipeline is identical.
    this.decks = DEFAULT_DECK_BODIES.map((body, i) => {
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(this.quadGeometry, this.buildDeckMaterial(body, i));
      mesh.frustumCulled = false;
      scene.add(mesh);

      const target = new THREE.WebGLRenderTarget(
        this.deckWidth,
        this.deckHeight,
        deckTargetOptions,
      );
      // mirrored repeat so zooming out (scale < 1) tiles instead of streaking
      target.texture.wrapS = THREE.MirroredRepeatWrapping;
      target.texture.wrapT = THREE.MirroredRepeatWrapping;

      return { scene, mesh, body, target, mode: 'shader' as const, model: null, sprite: null, landscape: null };
    });

    this.spriteGeometry = new THREE.PlaneGeometry(1, 1);
    this.automation = DEFAULT_DECK_BODIES.map(() => makeDefaultAut());
    this.positions = DEFAULT_DECK_BODIES.map(() => ({ x: 0, y: 0 }));
    this.lighting = DEFAULT_DECK_BODIES.map(() => ({ brightness: 1, angle: 0 }));

    this.modelCamera = new THREE.PerspectiveCamera(
      45,
      this.deckWidth / this.deckHeight,
      0.1,
      100,
    );
    this.modelCamera.position.set(0, 0, 4);
    this.modelCamera.lookAt(0, 0, 0);

    // Per-slot uniform objects, shared by reference between the scene
    // composites and the master composite — one write reaches all of them.
    this.slotUniforms = this.decks.map((deck, i) => ({
      deck: { value: deck.target.texture },
      mix: { value: INITIAL_OPACITIES[i] },
      scale: { value: 1 },
      size: { value: new THREE.Vector2(1, 1) },
      // x = tilt (rad), y = contrast, z = hue (rad), w = saturation
      fx: { value: new THREE.Vector4(0, 1, 0, 1) },
      // x = AUT sine-warp, y = AUT shear (engine-driven, zero at rest)
      warp: { value: new THREE.Vector2(0, 0) },
      // compositing layer: 1 = top .. 4 = base; everything starts on the base
      layer: { value: 4 },
    }));
    this.baseParams = this.decks.map((_, i) => ({
      mix: INITIAL_OPACITIES[i],
      scale: 1,
      size: { x: 1, y: 1 },
      fx: new THREE.Vector4(0, 1, 0, 1),
    }));
    this.loops = this.decks.map(() => null);
    this.bpm = 120;
    this.loopScratch = this.decks.map(() => ({
      base: { mix: 0, scale: 1, size: { x: 1, y: 1 }, fx: new THREE.Vector4(0, 1, 0, 1) },
      pos: { x: 0, y: 0 },
      light: { brightness: 1, angle: 0 },
    }));
    this.compositeSpin = this.decks.map(() => ({ spin: 0 }));
    this.xfadeUniform = { value: 0 };
    this.aspectUniform = { value: this.deckWidth / this.deckHeight };

    this.sceneComposites = [0, 1].map((scene) =>
      makeCompositeScene(
        this.quadGeometry,
        sceneUniformSet(this.slotUniforms, this.aspectUniform, this.sharedUniforms.u_time, scene),
        SCENE_FRAGMENT,
      ),
    );
    this.masterComposite = makeCompositeScene(
      this.quadGeometry,
      masterUniformSet(
        this.slotUniforms,
        this.aspectUniform,
        this.sharedUniforms.u_time,
        this.xfadeUniform,
      ),
      COMPOSITE_FRAGMENT,
    );

    // preview transform pass: one material, retargeted per deck each use
    this.previewUniforms = {
      u_tex: { value: null },
      u_scale: { value: 1 },
      u_size: { value: new THREE.Vector2(1, 1) },
      u_fx: { value: new THREE.Vector4(0, 1, 0, 1) },
      u_warp: { value: new THREE.Vector2(0, 0) },
      u_aspect: this.aspectUniform,
      u_time: this.sharedUniforms.u_time,
    };
    this.previewScene = makeCompositeScene(this.quadGeometry, this.previewUniforms, PREVIEW_FRAGMENT);

    // The 4 on-screen preview canvases show the *cued* scene's channels; one
    // shared scratch target + buffer serves all of them (and staging compiles).
    this.cueScene = 0;
    this.previewSlots = previewCanvases.map((canvas) => ({
      canvas: canvas || null,
      ctx: canvas ? canvas.getContext('2d') : null,
    }));
    this.previewTarget = new THREE.WebGLRenderTarget(
      this.previewWidth,
      this.previewHeight,
      targetOptions,
    );
    this.previewBuffer = new Uint8Array(this.previewWidth * this.previewHeight * 4);
    this.previewImage = new ImageData(this.previewWidth, this.previewHeight);
    this.syncPreviewCanvases();
    this.appliedAspect = this.deckWidth / this.deckHeight;

    this.frame = 0;
    this.running = true;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  buildDeckMaterial(body: string, deckIndex: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      // spreads copy the *references* to the {value} objects: time/resolution
      // are global, audio comes from this deck's routed set
      uniforms: { ...this.sharedUniforms, ...this.deckAudioUniforms[deckIndex] },
      vertexShader: VERTEX_SHADER,
      fragmentShader: buildFragmentShader(body),
    });
  }

  setOpacity(deckIndex: number, value: number): void {
    this.baseParams[deckIndex].mix = value;
    this.slotUniforms[deckIndex].mix.value = value;
  }

  setScale(deckIndex: number, value: number): void {
    this.baseParams[deckIndex].scale = value;
    this.slotUniforms[deckIndex].scale.value = value;
  }

  setSize(deckIndex: number, x: number, y: number): void {
    this.baseParams[deckIndex].size = { x, y };
    this.slotUniforms[deckIndex].size.value.set(x, y);
  }

  setCrossfade(value: number): void {
    this.xfadeUniform.value = value;
  }

  // tilt and hue in radians
  setChannelFx(deckIndex: number, tilt: number, contrast: number, hue: number, sat: number): void {
    this.baseParams[deckIndex].fx.set(tilt, contrast, hue, sat);
    this.slotUniforms[deckIndex].fx.value.set(tilt, contrast, hue, sat);
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

  /** @param angle key-light orbit in radians */
  setLighting(deckIndex: number, brightness: number, angle: number): void {
    this.lighting[deckIndex] = { brightness, angle };
  }

  /** @param layer compositing layer 1 (top) .. 4 (base) */
  setLayer(deckIndex: number, layer: number): void {
    this.slotUniforms[deckIndex].layer.value = layer;
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
  }

  setLoop(deckIndex: number, loop: DeckLoop | null): void {
    this.loops[deckIndex] = loop;
  }

  // Evaluate the deck's automation lanes at the given phase and overlay them
  // on the knob-set values: knobs stay untouched (stopping the loop lands
  // back on them), the FADER lane multiplies the fader so mute still wins,
  // every other lane overrides its control absolutely.
  private applyLoopOverrides(
    deckIndex: number,
    loop: DeckLoop,
    phase: number,
  ): { base: SlotBaseParams; pos: ChannelPos; light: ChannelLight } {
    const scratch = this.loopScratch[deckIndex];
    const base = this.baseParams[deckIndex];
    const pos = this.positions[deckIndex];
    const light = this.lighting[deckIndex];

    scratch.base.mix = base.mix;
    scratch.base.scale = base.scale;
    scratch.base.size.x = base.size.x;
    scratch.base.size.y = base.size.y;
    scratch.base.fx.copy(base.fx);
    scratch.pos.x = pos.x;
    scratch.pos.y = pos.y;
    scratch.light.brightness = light.brightness;
    scratch.light.angle = light.angle;

    const lane = (id: keyof DeckLoop['lanes']): number | null => {
      const points = loop.lanes[id];
      return points ? sampleLane(points, phase) : null;
    };
    const lerp = (lo: number, hi: number, v: number) => lo + (hi - lo) * v;

    const opacity = lane('opacity');
    if (opacity !== null) scratch.base.mix = base.mix * opacity;
    const scale = lane('scale');
    if (scale !== null) scratch.base.scale = lerp(0.25, 3, scale);
    const sizeX = lane('sizeX');
    if (sizeX !== null) scratch.base.size.x = lerp(0.05, 1, sizeX);
    const sizeY = lane('sizeY');
    if (sizeY !== null) scratch.base.size.y = lerp(0.05, 1, sizeY);
    const posX = lane('posX');
    if (posX !== null) scratch.pos.x = lerp(-2, 2, posX);
    const posY = lane('posY');
    if (posY !== null) scratch.pos.y = lerp(-2, 2, posY);
    const tilt = lane('tilt');
    if (tilt !== null) scratch.base.fx.x = lerp(-Math.PI, Math.PI, tilt);
    const contrast = lane('contrast');
    if (contrast !== null) scratch.base.fx.y = lerp(0, 2, contrast);
    const hue = lane('hue');
    if (hue !== null) scratch.base.fx.z = lerp(-Math.PI, Math.PI, hue);
    const sat = lane('sat');
    if (sat !== null) scratch.base.fx.w = lerp(0, 2, sat);
    const brightness = lane('brightness');
    if (brightness !== null) scratch.light.brightness = lerp(0, 2, brightness);
    const lightAngle = lane('lightAngle');
    if (lightAngle !== null) scratch.light.angle = lerp(-Math.PI, Math.PI, lightAngle);

    return { base: scratch.base, pos: scratch.pos, light: scratch.light };
  }

  // Return every deck to its baseline shader, disposing staged models,
  // sprites and landscapes. Library content on disk is untouched.
  resetAllDecks(): void {
    this.decks.forEach((deck, i) => {
      this.stageShader(i, DEFAULT_DECK_BODIES[i]);
      this.compositeSpin[i].spin = 0;
    });
  }

  // Attach/detach the master-out canvas (lives in a pop-out window; same
  // renderer process, so the per-frame blit works exactly like the A/B views).
  setMasterCanvas(canvas: HTMLCanvasElement | null): void {
    this.views.master = {
      canvas: canvas || null,
      ctx: canvas ? canvas.getContext('2d') : null,
    };
  }

  // Two-layer staging compile: a raw WebGL precompile catches syntax errors
  // cheaply, then a hidden render of the staging material through three.js
  // catches anything the precompile context misses. The active material is
  // only swapped (and disposed) if both pass.
  stageShader(deckIndex: number, body: string): StageResult {
    const gl = this.renderer.getContext();
    const fullSource = buildFragmentShader(body);

    const precompileError = validateFragmentSource(gl, fullSource);
    if (precompileError) {
      console.error('[Vizzy] Staging precompile failed:', precompileError);
      return { ok: false, error: precompileError };
    }

    const deck = this.decks[deckIndex];
    const stagingMaterial = this.buildDeckMaterial(body, deckIndex);
    const activeMaterial = deck.mesh.material;

    this.shaderError = null;
    deck.mesh.material = stagingMaterial;
    this.sharedUniforms.u_resolution.value.set(this.previewWidth, this.previewHeight);
    this.renderer.setRenderTarget(this.previewTarget);
    this.renderer.render(deck.scene, this.camera);
    this.renderer.setRenderTarget(null);

    if (this.shaderError) {
      const error = this.shaderError;
      this.shaderError = null;
      deck.mesh.material = activeMaterial;
      stagingMaterial.dispose();
      return { ok: false, error };
    }

    activeMaterial.dispose();
    deck.body = body;
    this.disposeModel(deck);
    this.disposeSprite(deck);
    this.disposeLandscape(deck);
    deck.mode = 'shader';
    return { ok: true };
  }

  // Put an image on a deck: centered quad preserving the image's aspect
  // within the render frame, alpha respected, scale-pulsing with the deck's
  // routed audio.
  stageSprite(deckIndex: number, texture: THREE.Texture, imageAspect: number, spriteId: string): StageResult {
    const deck = this.decks[deckIndex];
    // pre-upload the image to the GPU so the swap frame doesn't hitch
    this.renderer.initTexture(texture);
    this.disposeModel(deck);
    this.disposeSprite(deck);
    this.disposeLandscape(deck);

    const mesh = new THREE.Mesh(
      this.spriteGeometry,
      new THREE.ShaderMaterial({
        uniforms: {
          u_map: { value: texture },
          u_opacity: { value: 1 },
          u_distort: { value: 0 },
          u_skew: { value: 0 },
          u_time: { value: 0 },
        },
        vertexShader: SPRITE_VERTEX,
        fragmentShader: SPRITE_FRAGMENT,
        transparent: true,
      }),
    );
    mesh.frustumCulled = false;
    // The container absorbs the aspect compensation OUTSIDE the mesh's
    // rotation: the mesh rotates in isotropic units (rigid, no shearing) and
    // the container's non-uniform scale cancels the screen's NDC stretch.
    const container = new THREE.Group();
    container.add(mesh);
    const scene = new THREE.Scene();
    scene.add(container);

    deck.sprite = { scene, container, mesh, spriteId, imageAspect, baseW: 1, baseH: 1, spin: 0 };
    this.updateSpriteLayout(deck);
    deck.mode = 'sprite';
    return { ok: true };
  }

  // Sizes are in aspect-isotropic units (equal pixels per unit on both axes);
  // the container converts them to the ortho camera's stretched NDC space.
  // Contain-fit to ~85% of the frame.
  updateSpriteLayout(deck: Deck): void {
    if (!deck.sprite) return;
    const viewAspect = this.aspectUniform.value || 1;
    deck.sprite.container.scale.set(1 / viewAspect, 1, 1);
    const h = Math.min(1.7, (1.7 * viewAspect) / deck.sprite.imageAspect);
    deck.sprite.baseW = h * deck.sprite.imageAspect;
    deck.sprite.baseH = h;
  }

  disposeSprite(deck: Deck): void {
    if (!deck.sprite) return;
    (deck.sprite.mesh.material.uniforms.u_map.value as THREE.Texture | null)?.dispose();
    deck.sprite.mesh.material.dispose();
    deck.sprite = null;
  }

  // The vaporwave light rig: warm ambient, magenta key, cyan rim. Base
  // intensities and the key orbit are recorded so channel light controls can
  // restyle it live.
  private buildLightRig(
    scene: THREE.Scene,
    keyPos: THREE.Vector3,
    intensity: { ambient: number; key: number; rim: number },
    keyColor: THREE.ColorRepresentation,
    rimPos: THREE.Vector3,
  ): LightRig {
    const ambient = new THREE.AmbientLight(0xffffff, intensity.ambient);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(keyColor, intensity.key);
    key.position.copy(keyPos);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x22d3ee, intensity.rim);
    rim.position.copy(rimPos);
    scene.add(rim);
    return {
      ambient,
      key,
      rim,
      ambientBase: intensity.ambient,
      keyBase: intensity.key,
      rimBase: intensity.rim,
      keyRadius: Math.hypot(keyPos.x, keyPos.z) || 1,
      keyBaseAngle: Math.atan2(keyPos.x, keyPos.z),
      keyHeight: keyPos.y,
    };
  }

  // Put a loaded 3D object on a deck: auto-centered and normalized to the
  // camera, lit, slowly rotating, scale-pulsing with the deck's routed audio.
  // Async on purpose: shaders are pre-compiled in parallel and buffers
  // pre-uploaded BEFORE the swap, so the running visuals never stall on the
  // first frame of a new model. The old content keeps playing until ready.
  async stageModel(deckIndex: number, object3D: THREE.Object3D, modelId: string): Promise<StageResult> {
    const deck = this.decks[deckIndex];

    const box = new THREE.Box3().setFromObject(object3D);
    const sizeVec = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) || 1;
    object3D.position.sub(center);

    const group = new THREE.Group();
    group.add(object3D);
    const baseScale = 2.2 / maxDim;
    group.scale.setScalar(baseScale);

    const scene = new THREE.Scene();
    scene.add(group);
    const rig = this.buildLightRig(
      scene,
      new THREE.Vector3(2, 3, 4),
      { ambient: 0.5, key: 1.6, rim: 1.2 },
      0xffffff, // models keep their neutral key so imported materials read true
      new THREE.Vector3(-3, -1, -2),
    );

    // 1) parallel (non-blocking) shader compilation for all the file's materials
    try {
      if (this.renderer.compileAsync) {
        await this.renderer.compileAsync(scene, this.modelCamera);
      }
    } catch (err) {
      // worst case the first visible frame compiles inline, as before
      console.warn('[Vizzy] Async shader compile failed, continuing:', err);
    }
    // 2) one warm-up render to the scratch target uploads geometry + textures
    this.renderer.setRenderTarget(this.previewTarget);
    this.renderer.render(scene, this.modelCamera);
    this.renderer.setRenderTarget(null);

    // ready — swap atomically (old model/sprite disposed only now)
    this.disposeModel(deck);
    this.disposeSprite(deck);
    this.disposeLandscape(deck);
    deck.model = { scene, group, modelId, baseScale, spin: 0, rig };
    deck.mode = 'model';
    return { ok: true };
  }

  // Shared endless-flight staging: the object becomes a tile scrolling past
  // the camera, duplicated and MIRRORED in z so the seam where the two copies
  // meet always lines up. Same precompile-then-swap discipline as stageModel.
  private async stageTiledFlight(
    deckIndex: number,
    object3D: THREE.Object3D,
    opts: {
      mode: 'landscape' | 'scene';
      fly: 'over' | 'through';
      modelId?: string;
      spec?: SceneSpec;
      /** scale widest horizontal axis to LANDSCAPE_WIDTH (imported meshes) */
      normalize: boolean;
      /** rest the bounding box on y=0 (fly-over) vs keep centred (tunnels) */
      ground: boolean;
      /** light rig config, or null for genuinely unlit content */
      lights: {
        intensity: { ambient: number; key: number; rim: number };
        keyColor: THREE.ColorRepresentation;
        keyPos: THREE.Vector3;
        rimPos: THREE.Vector3;
      } | null;
      fogColor: THREE.ColorRepresentation;
    },
  ): Promise<StageResult> {
    const deck = this.decks[deckIndex];

    const box = new THREE.Box3().setFromObject(object3D);
    const sizeVec = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const widest = Math.max(sizeVec.x, sizeVec.z) || 1;
    const scale = opts.normalize ? LANDSCAPE_WIDTH / widest : 1;
    object3D.position.set(-center.x, opts.ground ? -box.min.y : -center.y, -center.z);

    // both copies render the same geometry — clone shares geometry/materials
    const span = Math.max(sizeVec.z * scale, 1);
    const height = Math.max(sizeVec.y * scale, 0.01);
    const tiles: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
    tiles.forEach((tile, i) => {
      const copy = i === 0 ? object3D : object3D.clone(true);
      tile.add(copy);
      tile.scale.set(scale, scale, i === 0 ? scale : -scale); // mirror seam-to-seam
      tile.position.z = -i * span;
    });
    // mirrored z flips winding — render both faces so the mirror tile shows
    object3D.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => {
        material.side = THREE.DoubleSide;
      });
    });

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(opts.fogColor, span * 0.3, span * 1.9);
    tiles.forEach((tile) => scene.add(tile));
    const rig = opts.lights
      ? this.buildLightRig(
          scene,
          opts.lights.keyPos,
          opts.lights.intensity,
          opts.lights.keyColor,
          opts.lights.rimPos,
        )
      : undefined;

    const camHeight = opts.fly === 'through' ? 0 : height * 0.55 + 0.5;
    const camera = new THREE.PerspectiveCamera(
      64,
      this.deckWidth / this.deckHeight,
      0.05,
      span * 2.5,
    );
    camera.position.set(0, camHeight, span * 0.45);
    camera.lookAt(0, opts.fly === 'through' ? camHeight : camHeight * 0.45, -6);

    try {
      if (this.renderer.compileAsync) {
        await this.renderer.compileAsync(scene, camera);
      }
    } catch (err) {
      console.warn('[Vizzy] Async shader compile failed, continuing:', err);
    }
    this.renderer.setRenderTarget(this.previewTarget);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);

    this.disposeModel(deck);
    this.disposeSprite(deck);
    this.disposeLandscape(deck);
    deck.landscape = {
      scene,
      tiles,
      camera,
      rig,
      fly: opts.fly,
      modelId: opts.modelId,
      spec: opts.spec,
      span,
      camHeight,
      scroll: 0,
    };
    deck.mode = opts.mode;
    return { ok: true };
  }

  // Put a mesh on a deck as fly-over terrain (vaporwave landscape mode).
  stageLandscape(
    deckIndex: number,
    object3D: THREE.Object3D,
    modelId: string,
  ): Promise<StageResult> {
    return this.stageTiledFlight(deckIndex, object3D, {
      mode: 'landscape',
      fly: 'over',
      modelId,
      normalize: true,
      ground: true,
      lights: {
        intensity: { ambient: 0.45, key: 1.4, rim: 0.9 },
        keyColor: 0xe879f9, // magenta horizon sun
        keyPos: new THREE.Vector3(0, 2, -6),
        rimPos: new THREE.Vector3(3, 4, 2),
      },
      fogColor: 0x000000,
    });
  }

  // Put a procedurally generated scene on a deck: terrain flies over, tunnels
  // fly through the axis. Vertex colours carry the palette, so the rig is
  // ambient-heavy with a neutral key — bright by default, but the LIGHT
  // channel controls can dim it or swing the sun around. Fog takes the
  // spec's third palette colour.
  stageScene(deckIndex: number, object3D: THREE.Object3D, spec: SceneSpec): Promise<StageResult> {
    return this.stageTiledFlight(deckIndex, object3D, {
      mode: 'scene',
      fly: spec.kind === 'tunnel' ? 'through' : 'over',
      spec,
      normalize: false,
      ground: spec.kind !== 'tunnel',
      lights: {
        intensity: { ambient: 0.8, key: 0.8, rim: 0.45 },
        keyColor: 0xffffff, // neutral key keeps the palette true
        keyPos: new THREE.Vector3(0, 2, -6),
        rimPos: new THREE.Vector3(3, 4, 2),
      },
      fogColor: spec.palette[2],
    });
  }

  disposeLandscape(deck: Deck): void {
    if (!deck.landscape) return;
    this.disposeObjectTree(deck.landscape.scene);
    deck.landscape = null;
  }

  disposeObjectTree(root: THREE.Object3D): void {
    root.traverse((node) => {
      const obj = node as THREE.Mesh;
      obj.geometry?.dispose?.();
      const materials = Array.isArray(obj.material)
        ? obj.material
        : obj.material
          ? [obj.material]
          : [];
      materials.forEach((material) => {
        Object.values(material).forEach((value) => {
          if ((value as THREE.Texture | null)?.isTexture) (value as THREE.Texture).dispose();
        });
        material.dispose();
      });
    });
  }

  disposeModel(deck: Deck): void {
    if (!deck.model) return;
    this.disposeObjectTree(deck.model.scene);
    deck.model = null;
  }

  getShaderBody(deckIndex: number): string {
    return this.decks[deckIndex].body;
  }

  // What's running on a slot — used by deck-preset save
  getChannelSource(deckIndex: number): ChannelSource {
    const deck = this.decks[deckIndex];
    if (deck.mode === 'model' && deck.model) {
      return { type: 'model', modelId: deck.model.modelId };
    }
    if (deck.mode === 'sprite' && deck.sprite) {
      return { type: 'sprite', spriteId: deck.sprite.spriteId };
    }
    if (deck.mode === 'landscape' && deck.landscape?.modelId) {
      return { type: 'landscape', modelId: deck.landscape.modelId };
    }
    if (deck.mode === 'scene' && deck.landscape?.spec) {
      return { type: 'scene', spec: deck.landscape.spec };
    }
    return { type: 'shader', code: deck.body };
  }

  // Snapshot of a channel's live preview canvas — pure 2D-canvas read, so
  // saving a shader never touches the GL pipeline mid-performance.
  getPreviewDataURL(channelIndex: number): string | null {
    const ctx = this.previewSlots[channelIndex]?.ctx;
    return ctx ? ctx.canvas.toDataURL('image/jpeg', 0.75) : null;
  }

  // Downscaled snapshot of a scene view (the A/B composite) for deck-preset
  // thumbnails — also a pure 2D-canvas read.
  getSceneDataURL(sceneIndex: number): string | null {
    const src = this.views[sceneIndex === 0 ? 'a' : 'b']?.canvas;
    if (!src || src.width === 0 || src.height === 0) return null;
    const thumb = document.createElement('canvas');
    thumb.width = 160;
    thumb.height = Math.max(1, Math.round((160 * src.height) / src.width));
    thumb.getContext('2d')!.drawImage(src, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL('image/jpeg', 0.75);
  }

  syncPreviewCanvases(): void {
    this.previewSlots.forEach((slot) => {
      if (!slot.canvas) return;
      slot.canvas.width = this.previewWidth;
      slot.canvas.height = this.previewHeight;
    });
  }

  // Deck targets track the scene views' aspect ratio, so shaders render at
  // the shape they're shown at; applied only once the aspect settles.
  maybeResizeDecks(aspect: number): void {
    if (Math.abs(aspect - this.appliedAspect) < 0.01) {
      this.pendingAspect = null;
      this.aspectStableFrames = 0;
      return;
    }
    if (this.pendingAspect === null || Math.abs(aspect - this.pendingAspect) > 0.01) {
      this.pendingAspect = aspect;
      this.aspectStableFrames = 0;
      return;
    }
    this.aspectStableFrames += 1;
    if (this.aspectStableFrames < ASPECT_SETTLE_FRAMES) return;

    this.appliedAspect = aspect;
    this.pendingAspect = null;
    this.aspectStableFrames = 0;
    this.deckWidth = BASE_DECK_WIDTH;
    this.deckHeight = Math.max(16, Math.round(BASE_DECK_WIDTH / aspect));
    this.previewWidth = BASE_PREVIEW_WIDTH;
    this.previewHeight = Math.max(9, Math.round(BASE_PREVIEW_WIDTH / aspect));
    this.aspectUniform.value = this.deckWidth / this.deckHeight;
    this.modelCamera.aspect = this.aspectUniform.value;
    this.modelCamera.updateProjectionMatrix();
    this.decks.forEach((deck) => {
      this.updateSpriteLayout(deck);
      if (deck.landscape) {
        deck.landscape.camera.aspect = this.aspectUniform.value;
        deck.landscape.camera.updateProjectionMatrix();
      }
    });

    this.decks.forEach((deck) => {
      deck.target.setSize(this.deckWidth, this.deckHeight);
    });
    this.previewTarget.setSize(this.previewWidth, this.previewHeight);
    this.previewBuffer = new Uint8Array(this.previewWidth * this.previewHeight * 4);
    this.previewImage = new ImageData(this.previewWidth, this.previewHeight);
    this.syncPreviewCanvases();
  }

  // Render a composite pass on the hidden GL canvas, then copy it onto an
  // on-screen 2D view canvas (GPU-side drawImage).
  renderToView(compositeScene: THREE.Scene, view: BlitView | undefined): void {
    if (!view?.ctx || !view.canvas) return;
    const { canvas, ctx } = view;
    // the master canvas lives in another window — use ITS pixel ratio
    const dpr = (canvas.ownerDocument.defaultView || window).devicePixelRatio || 1;
    const pw = Math.round(canvas.clientWidth * dpr);
    const ph = Math.round(canvas.clientHeight * dpr);
    if (pw === 0 || ph === 0) return;
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    this.renderer.setRenderTarget(null);
    this.renderer.render(compositeScene, this.camera);

    // aspect-preserving contain-fit: the GL canvas matches the A/B views
    // exactly (no-op there) but the master monitor box may differ — letterbox
    // instead of stretching.
    const src = this.renderer.domElement;
    const fit = Math.min(pw / src.width, ph / src.height);
    const dw = Math.round(src.width * fit);
    const dh = Math.round(src.height * fit);
    if (dw !== pw || dh !== ph) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, pw, ph);
    }
    ctx.drawImage(src, Math.round((pw - dw) / 2), Math.round((ph - dh) / 2), dw, dh);
  }

  loop(): void {
    if (!this.running) return;
    this.frame += 1;

    // The master-out window, when open, is the primary view: it defines the
    // render aspect AND resolution, so the output window is always filled
    // edge-to-edge at native size while the in-app A/B views letterbox to
    // match (contain-fit in renderToView). Resizing the master window
    // re-shapes everything. With no master attached, the scene-A pane is
    // the primary.
    const masterCanvas = this.views.master?.canvas;
    const primary =
      masterCanvas && masterCanvas.isConnected ? masterCanvas : this.views.a?.canvas;
    if (primary && primary.clientWidth > 0 && primary.clientHeight > 0) {
      const dpr = (primary.ownerDocument.defaultView || window).devicePixelRatio || 1;
      const glCanvas = this.renderer.domElement;
      const pw = Math.round(primary.clientWidth * dpr);
      const ph = Math.round(primary.clientHeight * dpr);
      if (glCanvas.width !== pw || glCanvas.height !== ph) {
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(primary.clientWidth, primary.clientHeight, false);
      }
      this.maybeResizeDecks(primary.clientWidth / primary.clientHeight);
    }

    this.sharedUniforms.u_time.value = this.clock.getElapsedTime();
    if (this.audioEngine) {
      const audio = this.audioEngine.update();
      // per-deck routing: amt scales everything, the selected band drives
      // u_audio_level (the default 'level' routing is identity behaviour)
      this.deckAudioUniforms.forEach((u, i) => {
        const route = this.audioRouting[i];
        u.u_audio_low.value = Math.min(1, audio.low * route.amt);
        u.u_audio_mid.value = Math.min(1, audio.mid * route.amt);
        u.u_audio_high.value = Math.min(1, audio.high * route.amt);
        u.u_audio_level.value = Math.min(1, (audio[route.band] ?? audio.level) * route.amt);
      });
    }

    this.sharedUniforms.u_resolution.value.set(this.deckWidth, this.deckHeight);
    const t = this.sharedUniforms.u_time.value;
    const dt = Math.min(0.1, t - (this.lastFrameTime ?? t));
    this.lastFrameTime = t;
    this.decks.forEach((deck, i) => {
      const level = this.deckAudioUniforms[i].u_audio_level.value;

      // The looper overlays its lanes on the knob values for this frame only
      // — beat-locked to the global clock so every playing deck shares one
      // tempo grid. AUT still modulates on top of the looped values.
      let base = this.baseParams[i];
      let pos = this.positions[i];
      let light = this.lighting[i];
      const loop = this.loops[i];
      if (loop?.playing) {
        const beats = Math.max(0.125, loop.blocks * loop.divider);
        const phase = ((t * this.bpm) / 60 / beats) % 1;
        ({ base, pos, light } = this.applyLoopOverrides(i, loop, phase));
      }

      // Composite-stage automation: shader decks have no scene-graph, so AUT
      // modulates their sampling params; everything else animates in-scene
      // and keeps its composite params pinned to the knob values (TLT excepted
      // — tilt rocking is composite-level for every deck type).
      if (deck.mode === 'shader') {
        animateShaderComposite(
          this.slotUniforms[i],
          base,
          this.compositeSpin[i],
          this.automation[i],
          level,
          t,
          dt,
        );
      } else {
        pinCompositeToBase(this.slotUniforms[i], base, this.automation[i], level, t);
      }

      this.renderer.setRenderTarget(deck.target);
      if (deck.mode === 'model' && deck.model) {
        animateModelDeck(deck.model, this.automation[i], level, t, dt, pos);
        applyLightRig(deck.model.rig, light);
        this.renderer.render(deck.model.scene, this.modelCamera);
      } else if (deck.mode === 'sprite' && deck.sprite) {
        animateSpriteDeck(deck.sprite, this.automation[i], level, t, dt, pos);
        this.renderer.render(deck.sprite.scene, this.camera);
      } else if ((deck.mode === 'landscape' || deck.mode === 'scene') && deck.landscape) {
        animateLandscapeDeck(deck.landscape, this.automation[i], level, t, dt, pos);
        if (deck.landscape.rig) applyLightRig(deck.landscape.rig, light);
        this.renderer.render(deck.landscape.scene, deck.landscape.camera);
      } else {
        this.renderer.render(deck.scene, this.camera);
      }
    });

    this.renderToView(this.sceneComposites[0], this.views.a);
    this.renderToView(this.sceneComposites[1], this.views.b);
    this.renderToView(this.masterComposite, this.views.master);

    // Round-robin: one channel preview per frame (~15fps each at 60fps)
    // keeps the readPixels cost negligible.
    this.updatePreview(this.frame % CHANNELS);

    this.raf = requestAnimationFrame(this.loop);
  }

  updatePreview(channelIndex: number): void {
    const slot = this.previewSlots[channelIndex];
    if (!slot?.ctx) return;
    // previews always show the cued scene's channels, sampled from the deck's
    // already-rendered frame through the composite transform (scale + W/H
    // window) so the thumbnail matches the final output contribution.
    const slotIndex = this.cueScene * CHANNELS + channelIndex;
    const slotUniform = this.slotUniforms[slotIndex];
    this.previewUniforms.u_tex.value = this.decks[slotIndex].target.texture;
    this.previewUniforms.u_scale.value = slotUniform.scale.value;
    this.previewUniforms.u_size.value.copy(slotUniform.size.value);
    this.previewUniforms.u_fx.value.copy(slotUniform.fx.value);
    this.previewUniforms.u_warp.value.copy(slotUniform.warp.value);

    this.renderer.setRenderTarget(this.previewTarget);
    this.renderer.render(this.previewScene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.readRenderTargetPixels(
      this.previewTarget,
      0,
      0,
      this.previewWidth,
      this.previewHeight,
      this.previewBuffer,
    );

    flipAndPremultiply(this.previewBuffer, this.previewImage, this.previewWidth, this.previewHeight);
    slot.ctx.putImageData(this.previewImage, 0, 0);
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.decks.forEach((deck) => {
      deck.mesh.material.dispose();
      deck.target.dispose();
      this.disposeModel(deck);
      this.disposeSprite(deck);
      this.disposeLandscape(deck);
    });
    this.spriteGeometry.dispose();
    this.previewTarget.dispose();
    const disposeComposite = (scene: THREE.Scene) =>
      (scene.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | undefined)?.material.dispose();
    this.sceneComposites.forEach(disposeComposite);
    disposeComposite(this.masterComposite);
    disposeComposite(this.previewScene);
    this.quadGeometry.dispose();
    this.renderer.dispose();
  }
}
