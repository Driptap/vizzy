// Composite-pass construction: fullscreen-quad scenes whose materials mix the
// deck render targets. Slot uniforms are shared BY REFERENCE between the
// scene composites and the master composite — one write reaches all of them.
import * as THREE from 'three';
import { VERTEX_SHADER } from './shaders';
import { CHANNELS } from '../lib/channels';
import type { SlotUniforms } from './types';

type UniformSet = Record<string, THREE.IUniform>;

export function makeCompositeScene(
  quadGeometry: THREE.PlaneGeometry,
  uniforms: UniformSet,
  fragmentShader: string,
): THREE.Scene {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(
    quadGeometry,
    new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX_SHADER, fragmentShader }),
  );
  mesh.frustumCulled = false;
  scene.add(mesh);
  return scene;
}

const slotEntries = (uniforms: UniformSet, slot: SlotUniforms, n: number): void => {
  uniforms[`u_deck${n}`] = slot.deck;
  uniforms[`u_mix${n}`] = slot.mix;
  uniforms[`u_scale${n}`] = slot.scale;
  uniforms[`u_size${n}`] = slot.size;
  uniforms[`u_fx${n}`] = slot.fx;
  uniforms[`u_warp${n}`] = slot.warp;
  uniforms[`u_layer${n}`] = slot.layer;
};

/** Uniform set for one scene's 4-deck composite (channels named 1-4). */
export function sceneUniformSet(
  slotUniforms: SlotUniforms[],
  aspectUniform: THREE.IUniform<number>,
  timeUniform: THREE.IUniform<number>,
  sceneIndex: number,
): UniformSet {
  const uniforms: UniformSet = { u_aspect: aspectUniform, u_time: timeUniform };
  for (let ch = 0; ch < CHANNELS; ch += 1) {
    slotEntries(uniforms, slotUniforms[sceneIndex * CHANNELS + ch], ch + 1);
  }
  return uniforms;
}

/** Uniform set for the crossfaded 8-deck master composite. */
export function masterUniformSet(
  slotUniforms: SlotUniforms[],
  aspectUniform: THREE.IUniform<number>,
  timeUniform: THREE.IUniform<number>,
  xfadeUniform: THREE.IUniform<number>,
): UniformSet {
  const uniforms: UniformSet = {
    u_xfade: xfadeUniform,
    u_aspect: aspectUniform,
    u_time: timeUniform,
  };
  slotUniforms.forEach((slot, i) => slotEntries(uniforms, slot, i + 1));
  return uniforms;
}
