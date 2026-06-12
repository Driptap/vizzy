// Internal engine structures shared between RenderEngine and its helpers.
import type * as THREE from 'three';
import type { SceneSpec } from '../types';

export type DeckMode = 'shader' | 'model' | 'sprite' | 'landscape' | 'scene';

/**
 * The vaporwave light rig on lit decks, kept adjustable: base intensities and
 * the key light's orbit are recorded so channel light controls can scale and
 * steer them without losing the original look.
 */
export interface LightRig {
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  ambientBase: number;
  keyBase: number;
  rimBase: number;
  keyRadius: number;
  keyBaseAngle: number;
  keyHeight: number;
}

/** A staged 3D model: normalized, lit, slowly rotating. */
export interface ModelDeckContent {
  scene: THREE.Scene;
  group: THREE.Group;
  modelId: string;
  baseScale: number;
  spin: number;
  rig: LightRig;
}

/** A staged image sprite on a centered, aspect-preserving quad. */
export interface SpriteDeckContent {
  scene: THREE.Scene;
  container: THREE.Group;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  spriteId: string;
  imageAspect: number;
  baseW: number;
  baseH: number;
  spin: number;
}

/**
 * Content staged for endless flight: two mirrored copies of a mesh leapfrog
 * past the camera for a seamless infinite scroll. Used by landscape decks
 * (imported mesh, fly over) and procedural scene decks (generated terrain
 * fly-over or tunnel fly-through).
 */
export interface LandscapeDeckContent {
  scene: THREE.Scene;
  tiles: [THREE.Group, THREE.Group];
  camera: THREE.PerspectiveCamera;
  /** 'over' skims a low camera above the ground; 'through' flies the axis */
  fly: 'over' | 'through';
  /** library model id (landscape decks) */
  modelId?: string;
  /** generating spec (procedural scene decks) */
  spec?: SceneSpec;
  /** present on lit content (mesh landscapes); procedural scenes are unlit */
  rig?: LightRig;
  /** tile depth in world units — the scroll wraps on this period */
  span: number;
  /** camera height above the terrain ground plane (0 for fly-through) */
  camHeight: number;
  scroll: number;
}

/** One of the 8 deck slots: a shader quad, or swapped model/sprite/landscape content. */
export interface Deck {
  scene: THREE.Scene;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  body: string;
  target: THREE.WebGLRenderTarget;
  mode: DeckMode;
  model: ModelDeckContent | null;
  sprite: SpriteDeckContent | null;
  landscape: LandscapeDeckContent | null;
}

/** Per-slot composite uniforms, shared by reference across composite passes. */
export interface SlotUniforms {
  deck: THREE.IUniform<THREE.Texture>;
  mix: THREE.IUniform<number>;
  scale: THREE.IUniform<number>;
  size: THREE.IUniform<THREE.Vector2>;
  fx: THREE.IUniform<THREE.Vector4>;
  /** x = AUT sine-warp amount, y = AUT shear — engine-driven, 0 when idle */
  warp: THREE.IUniform<THREE.Vector2>;
  /** compositing layer 1 (top) .. 4 (base); same layer blends additively */
  layer: THREE.IUniform<number>;
}

/** The knob-set composite params AUT modulates around (never overwritten). */
export interface SlotBaseParams {
  mix: number;
  scale: number;
  size: { x: number; y: number };
  fx: THREE.Vector4;
}

export interface DeckAudioUniforms {
  u_audio_low: THREE.IUniform<number>;
  u_audio_mid: THREE.IUniform<number>;
  u_audio_high: THREE.IUniform<number>;
  u_audio_level: THREE.IUniform<number>;
}

/** An on-screen 2D canvas the GL output is blitted onto. */
export interface BlitView {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
}
