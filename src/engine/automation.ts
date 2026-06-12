// Per-frame automation for model and sprite decks. Each effect is
// {amt: 0..1, audio: bool}: audio couples it to the deck's routed level,
// otherwise it self-runs on time LFOs.
import type { AutomationMap } from '../types';
import type { ChannelPos } from '../types';
import type {
  LandscapeDeckContent,
  ModelDeckContent,
  SlotBaseParams,
  SlotUniforms,
  SpriteDeckContent,
} from './types';

const NO_OFFSET: ChannelPos = { x: 0, y: 0 };

export function animateModelDeck(
  model: ModelDeckContent,
  aut: AutomationMap,
  level: number,
  t: number,
  dt: number,
  pos: ChannelPos = NO_OFFSET,
): void {
  // ROT adds spin on top of a gentle always-on base rotation
  model.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);
  const pulse =
    1 + aut.scl.amt * 0.5 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 2.2));
  // DST = jelly squash-and-stretch (material-agnostic "distortion")
  const wobble =
    aut.dst.amt * 0.35 * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3));

  model.group.position.x = pos.x;
  model.group.position.y = pos.y;
  model.group.rotation.y = t * 0.3 + model.spin;
  model.group.rotation.x = Math.sin(t * 0.3) * 0.2;
  // SKW = side lean (true shear isn't expressible in TRS transforms)
  model.group.rotation.z = aut.skw.amt * 0.5 * (aut.skw.audio ? level : Math.sin(t * 0.9));
  model.group.scale.set(
    model.baseScale * pulse * (1 + wobble * Math.sin(t * 7.0)),
    model.baseScale * pulse * (1 - wobble * Math.sin(t * 7.0 + 1.0)),
    model.baseScale * pulse * (1 + wobble * Math.cos(t * 6.0)),
  );
  // FLK = whole-frame blink (works regardless of imported materials)
  model.group.visible = !(
    aut.flk.amt > 0 &&
    Math.random() < aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * 0.5
  );
}

export function animateSpriteDeck(
  sprite: SpriteDeckContent,
  aut: AutomationMap,
  level: number,
  t: number,
  dt: number,
  pos: ChannelPos = NO_OFFSET,
): void {
  const pulse =
    1 + aut.scl.amt * 0.6 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 2.2));
  sprite.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);

  sprite.mesh.scale.set(sprite.baseW * pulse, sprite.baseH * pulse, 1);
  sprite.mesh.position.x = pos.x;
  sprite.mesh.position.y = pos.y + Math.sin(t * 0.8) * 0.04;
  sprite.mesh.rotation.z = sprite.spin;

  const u = sprite.mesh.material.uniforms;
  u.u_time.value = t;
  u.u_opacity.value =
    1 - aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * Math.random();
  u.u_distort.value = aut.dst.amt * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3));
  u.u_skew.value = aut.skw.amt * 0.7 * (aut.skw.audio ? level : Math.sin(t * 0.9));
}

// Fly-over terrain: a constant forward scroll (always audio-boosted, like the
// tunnel shaders) with the AUT effects remapped to camera language —
// SCL = terrain height pulse, ROT = camera yaw sway, SKW = camera roll,
// DST = camera shake, FLK = whole-frame blink.
export function animateLandscapeDeck(
  landscape: LandscapeDeckContent,
  aut: AutomationMap,
  level: number,
  t: number,
  dt: number,
  pos: ChannelPos = NO_OFFSET,
): void {
  const baseSpeed = landscape.span / 9; // one tile every ~9s at rest
  landscape.scroll += dt * baseSpeed * (1 + level * 1.5 + aut.rot.amt * 0);
  // tiles march toward the camera (+z) and leapfrog back when passed
  landscape.tiles.forEach((tile, i) => {
    tile.position.z = ((landscape.scroll + i * landscape.span) % (2 * landscape.span)) - landscape.span;
    // SCL = terrain breathing; mirrored tiles keep their negative z scale
    const pulse =
      1 + aut.scl.amt * 0.6 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 1.7));
    tile.scale.y = pulse;
  });

  // POS pans the whole camera track: x slides it sideways (lookAt follows so
  // it translates rather than turns), y raises/lowers the fly-over height,
  // floored so the camera never dives under the terrain.
  const cam = landscape.camera;
  const sway = aut.rot.amt * 0.6 * (aut.rot.audio ? level : Math.sin(t * 0.4));
  const shake = aut.dst.amt * (aut.dst.audio ? level : 0.5 + 0.5 * Math.sin(t * 1.3));
  cam.position.x = pos.x + Math.sin(t * 0.23) * 0.4 + shake * 0.12 * Math.sin(t * 31.0);
  cam.position.y = Math.max(
    0.1,
    landscape.camHeight + pos.y + Math.sin(t * 0.6) * 0.08 + shake * 0.1 * Math.cos(t * 27.0),
  );
  cam.lookAt(pos.x + sway * 3, Math.max(0.05, (landscape.camHeight + pos.y) * 0.45), -6);
  // SKW = roll lean, applied after lookAt so it isn't overwritten
  cam.rotation.z += aut.skw.amt * 0.4 * (aut.skw.audio ? level : Math.sin(t * 0.9));

  // FLK = whole-frame blink
  landscape.scene.visible = !(
    aut.flk.amt > 0 &&
    Math.random() < aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * 0.5
  );
}

// Shader decks have no scene-graph to animate, so AUT modulates the deck's
// COMPOSITE sampling around the knob-set base values: SCL = zoom pulse,
// ROT = continuous spin (on top of the TILT knob), FLK = brightness flicker,
// DST = sine UV warp, SKW = shear. Base values are never mutated — turning an
// effect off lands back exactly on the knobs.
export function animateShaderComposite(
  uniforms: SlotUniforms,
  base: SlotBaseParams,
  state: { spin: number },
  aut: AutomationMap,
  level: number,
  t: number,
  dt: number,
): void {
  const pulse =
    1 + aut.scl.amt * 0.4 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 2.2));
  uniforms.scale.value = base.scale * pulse;

  state.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);
  uniforms.fx.value.set(base.fx.x + state.spin, base.fx.y, base.fx.z, base.fx.w);

  uniforms.mix.value =
    base.mix * (1 - aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * Math.random());

  uniforms.warp.value.set(
    aut.dst.amt * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3)),
    aut.skw.amt * 0.7 * (aut.skw.audio ? level : Math.sin(t * 0.9)),
  );
}

/** Non-shader decks animate in-scene — pin their composite params to base. */
export function resetShaderComposite(uniforms: SlotUniforms, base: SlotBaseParams): void {
  uniforms.scale.value = base.scale;
  uniforms.fx.value.copy(base.fx);
  uniforms.mix.value = base.mix;
  uniforms.warp.value.set(0, 0);
}
