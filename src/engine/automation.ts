// Per-frame automation for model and sprite decks. Each effect is
// {amt: 0..1, audio: bool}: audio couples it to the deck's routed level,
// otherwise it self-runs on time LFOs.
import type { AutomationMap } from '../types';
import type { ModelDeckContent, SpriteDeckContent } from './types';

export function animateModelDeck(
  model: ModelDeckContent,
  aut: AutomationMap,
  level: number,
  t: number,
  dt: number,
): void {
  // ROT adds spin on top of a gentle always-on base rotation
  model.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);
  const pulse =
    1 + aut.scl.amt * 0.5 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 2.2));
  // DST = jelly squash-and-stretch (material-agnostic "distortion")
  const wobble =
    aut.dst.amt * 0.35 * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3));

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
): void {
  const pulse =
    1 + aut.scl.amt * 0.6 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 2.2));
  sprite.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);

  sprite.mesh.scale.set(sprite.baseW * pulse, sprite.baseH * pulse, 1);
  sprite.mesh.position.y = Math.sin(t * 0.8) * 0.04;
  sprite.mesh.rotation.z = sprite.spin;

  const u = sprite.mesh.material.uniforms;
  u.u_time.value = t;
  u.u_opacity.value =
    1 - aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * Math.random();
  u.u_distort.value = aut.dst.amt * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3));
  u.u_skew.value = aut.skw.amt * 0.7 * (aut.skw.audio ? level : Math.sin(t * 0.9));
}
