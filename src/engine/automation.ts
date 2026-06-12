// Per-frame automation for model and sprite decks. Each effect is
// {amt: 0..1, audio: bool}: audio couples it to the deck's routed level,
// otherwise it self-runs on time LFOs.
import type { AutomationMap } from '../types';
import type { ChannelLight, ChannelPos } from '../types';
import type {
  LandscapeDeckContent,
  LightRig,
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
  // ROT drives the spin entirely — amt 0 parks the model where it is
  model.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);
  const pulse =
    1 + aut.scl.amt * 0.5 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 2.2));
  // DST = jelly squash-and-stretch (material-agnostic "distortion")
  const wobble =
    aut.dst.amt * 0.35 * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3));

  model.group.position.x = pos.x;
  model.group.position.y = pos.y;
  model.group.rotation.y = model.spin;
  // the gentle nod scales with ROT too, so a parked model is truly still
  model.group.rotation.x = aut.rot.amt * Math.sin(t * 0.3) * 0.2;
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
  landscape.scroll += dt * baseSpeed * (1 + level * 1.5);
  // tiles march toward the camera (+z) and leapfrog back when passed
  landscape.tiles.forEach((tile, i) => {
    tile.position.z = ((landscape.scroll + i * landscape.span) % (2 * landscape.span)) - landscape.span;
    // SCL = terrain breathing; mirrored tiles keep their negative z scale
    const pulse =
      1 + aut.scl.amt * 0.6 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 1.7));
    tile.scale.y = pulse;
  });

  // POS pans the whole camera track: x slides it sideways (lookAt follows so
  // it translates rather than turns), y raises/lowers the flight height.
  // Fly-over is floored so the camera never dives under the terrain;
  // fly-through (tunnels) aims straight down the axis instead.
  const cam = landscape.camera;
  const sway = aut.rot.amt * 0.6 * (aut.rot.audio ? level : Math.sin(t * 0.4));
  const shake = aut.dst.amt * (aut.dst.audio ? level : 0.5 + 0.5 * Math.sin(t * 1.3));
  const bobX = Math.sin(t * 0.23) * 0.4 + shake * 0.12 * Math.sin(t * 31.0);
  const bobY = Math.sin(t * 0.6) * 0.08 + shake * 0.1 * Math.cos(t * 27.0);
  cam.position.x = pos.x + bobX;
  if (landscape.fly === 'through') {
    cam.position.y = landscape.camHeight + pos.y + bobY;
    cam.lookAt(pos.x + sway * 3, landscape.camHeight + pos.y, -6);
  } else {
    cam.position.y = Math.max(0.1, landscape.camHeight + pos.y + bobY);
    cam.lookAt(pos.x + sway * 3, Math.max(0.05, (landscape.camHeight + pos.y) * 0.45), -6);
  }
  // SKW = roll lean, applied after lookAt so it isn't overwritten
  cam.rotation.z += aut.skw.amt * 0.4 * (aut.skw.audio ? level : Math.sin(t * 0.9));

  // FLK = whole-frame blink
  landscape.scene.visible = !(
    aut.flk.amt > 0 &&
    Math.random() < aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * 0.5
  );
}

// TLT rocks the composite tilt around the TILT knob — it works at the
// sampling stage, so it applies to EVERY deck type.
const tiltWobble = (aut: AutomationMap, level: number, t: number): number =>
  aut.tlt.amt * 0.6 * (aut.tlt.audio ? level : Math.sin(t * 0.8));

// Shader decks have no scene-graph to animate, so AUT modulates the deck's
// COMPOSITE sampling around the knob-set base values: SCL = zoom pulse,
// ROT = continuous spin (on top of the TILT knob), TLT = tilt rocking,
// FLK = brightness flicker, DST = sine UV warp, SKW = shear. Base values are
// never mutated — turning an effect off lands back exactly on the knobs.
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
  uniforms.size.value.set(base.size.x, base.size.y);

  state.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);
  uniforms.fx.value.set(
    base.fx.x + state.spin + tiltWobble(aut, level, t),
    base.fx.y,
    base.fx.z,
    base.fx.w,
  );

  uniforms.mix.value =
    base.mix * (1 - aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * Math.random());

  uniforms.warp.value.set(
    aut.dst.amt * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3)),
    aut.skw.amt * 0.7 * (aut.skw.audio ? level : Math.sin(t * 0.9)),
  );
}

/**
 * Non-shader decks animate in-scene, so their composite params stay pinned to
 * the knob values — except TLT, which is composite-level for every deck type.
 */
export function pinCompositeToBase(
  uniforms: SlotUniforms,
  base: SlotBaseParams,
  aut: AutomationMap,
  level: number,
  t: number,
): void {
  uniforms.scale.value = base.scale;
  uniforms.size.value.set(base.size.x, base.size.y);
  uniforms.fx.value.set(base.fx.x + tiltWobble(aut, level, t), base.fx.y, base.fx.z, base.fx.w);
  uniforms.mix.value = base.mix;
  uniforms.warp.value.set(0, 0);
}

// Channel light controls for lit decks: brightness scales the whole rig,
// angle orbits the key light around the vertical axis (the rim stays put so
// the silhouette edge survives any key direction).
export function applyLightRig(rig: LightRig, light: ChannelLight): void {
  rig.ambient.intensity = rig.ambientBase * light.brightness;
  rig.key.intensity = rig.keyBase * light.brightness;
  rig.rim.intensity = rig.rimBase * light.brightness;
  const angle = rig.keyBaseAngle + light.angle;
  rig.key.position.set(
    rig.keyRadius * Math.sin(angle),
    rig.keyHeight,
    rig.keyRadius * Math.cos(angle),
  );
}
