// Internal engine structures shared between RenderEngine and its helpers.
import type * as THREE from 'three';

export type DeckMode = 'shader' | 'model' | 'sprite';

/** A staged 3D model: normalized, lit, slowly rotating. */
export interface ModelDeckContent {
  scene: THREE.Scene;
  group: THREE.Group;
  modelId: string;
  baseScale: number;
  spin: number;
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

/** One of the 8 deck slots: a shader quad, or swapped model/sprite content. */
export interface Deck {
  scene: THREE.Scene;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  body: string;
  target: THREE.WebGLRenderTarget;
  mode: DeckMode;
  model: ModelDeckContent | null;
  sprite: SpriteDeckContent | null;
}

/** Per-slot composite uniforms, shared by reference across composite passes. */
export interface SlotUniforms {
  deck: THREE.IUniform<THREE.Texture>;
  mix: THREE.IUniform<number>;
  scale: THREE.IUniform<number>;
  size: THREE.IUniform<THREE.Vector2>;
  fx: THREE.IUniform<THREE.Vector4>;
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
