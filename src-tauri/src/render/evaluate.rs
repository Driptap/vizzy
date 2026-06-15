// Per-frame parameter evaluation on the render thread (Phase 4): loop lanes,
// AUT effects, audio routing, and the deck content state machines. Ported
// 1:1 from the TS sources they replace — sampleLane (loopControls.ts), the
// animate* functions (automation.ts), applyLoopOverrides + the sprite matrix
// composition (NativeRenderEngine.ts) and updateSpriteLayout (RenderEngine.ts).
use std::f32::consts::PI;

use super::math3d;
use super::params::{
    filter_kind_index, DeckDraw, EvaluatedFrame, FilterFrame, FlightDraw, ModelDraw, Slot,
    SlotFrame, SpriteDraw, SLOT_COUNT,
};
use super::state::{AutMap, LanePoint, LoopState, RenderStateMsg, SlotState};

/// stageTiledFlight's camera.
pub const FLIGHT_FOV: f32 = 64.0;
const FALLBACK_ASPECT: f32 = 16.0 / 9.0;
/// AudioEngine/NativeAudioEngine: per-frame lerp factor and input gain.
const SMOOTHING: f32 = 0.15;
const AUDIO_GAIN: f32 = 1.4;

/// Sample a lane at phase u (0..1). Segments ease with the LEADING point's
/// bend: 0 = linear, +1 bends hard late (slow start), -1 bends hard early.
pub fn sample_lane(points: &[LanePoint], u: f32) -> f32 {
    let Some(first) = points.first() else {
        return 0.0;
    };
    let x = u.clamp(0.0, 1.0);
    if x <= first.t {
        return first.v;
    }
    let last = points[points.len() - 1];
    if x >= last.t {
        return last.v;
    }
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if x <= b.t {
            let span = match b.t - a.t {
                s if s != 0.0 => s,
                _ => 1e-9,
            };
            let f = (x - a.t) / span;
            let eased = f.powf(4f32.powf(a.bend));
            return a.v + (b.v - a.v) * eased;
        }
    }
    last.v
}

fn lerp(lo: f32, hi: f32, v: f32) -> f32 {
    lo + (hi - lo) * v
}

/// Knob-set base values before AUT modulation (SlotBaseParams + pos + light).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Base {
    mix: f32,
    scale: f32,
    size: [f32; 2],
    /// tilt, contrast, hue, sat
    fx: [f32; 4],
    pos: [f32; 2],
    /// brightness, angle
    light: [f32; 2],
}

impl Base {
    fn from_knobs(s: &SlotState) -> Self {
        Self {
            mix: s.mix,
            scale: s.scale,
            size: [s.size_x, s.size_y],
            fx: [s.tilt, s.contrast, s.hue, s.sat],
            pos: [s.pos_x, s.pos_y],
            light: [s.brightness, s.light_angle],
        }
    }
}

/// Loop lanes override the knobs absolutely — except the fader lane, which
/// MULTIPLIES the knob mix so mute wins. Ranges mirror
/// NativeRenderEngine.applyLoopOverrides exactly.
fn apply_loop_overrides(base: &mut Base, lp: &LoopState, phase: f32) {
    let lane = |id: &str| lp.lanes.get(id).map(|points| sample_lane(points, phase));
    if let Some(v) = lane("opacity") {
        base.mix *= v; // fader lane multiplies: mute wins
    }
    if let Some(v) = lane("scale") {
        base.scale = lerp(0.25, 3.0, v);
    }
    if let Some(v) = lane("sizeX") {
        base.size[0] = lerp(0.05, 1.0, v);
    }
    if let Some(v) = lane("sizeY") {
        base.size[1] = lerp(0.05, 1.0, v);
    }
    if let Some(v) = lane("posX") {
        base.pos[0] = lerp(-2.0, 2.0, v);
    }
    if let Some(v) = lane("posY") {
        base.pos[1] = lerp(-2.0, 2.0, v);
    }
    if let Some(v) = lane("tilt") {
        base.fx[0] = lerp(-PI, PI, v);
    }
    if let Some(v) = lane("contrast") {
        base.fx[1] = lerp(0.0, 2.0, v);
    }
    if let Some(v) = lane("hue") {
        base.fx[2] = lerp(-PI, PI, v);
    }
    if let Some(v) = lane("sat") {
        base.fx[3] = lerp(0.0, 2.0, v);
    }
    if let Some(v) = lane("brightness") {
        base.light[0] = lerp(0.0, 2.0, v);
    }
    if let Some(v) = lane("lightAngle") {
        base.light[1] = lerp(-PI, PI, v);
    }
}

/// Per-slot routed audio: amt scales all bands; the selected source drives
/// `level` (the value AUT effects and flight scroll react to). `beats` carries
/// the already-shaped onset envelopes `[low, mid, high, combined]`, each
/// routable like a band.
fn route_audio(bands: [f32; 4], beats: [f32; 4], band: &str, amt: f32) -> [f32; 4] {
    let selected = match band {
        "low" => bands[0],
        "mid" => bands[1],
        "high" => bands[2],
        "beat" => beats[3],
        "beat-low" => beats[0],
        "beat-mid" => beats[1],
        "beat-high" => beats[2],
        _ => bands[3], // unknown bands fall back to level, like `?? audio.level`
    };
    [
        (bands[0] * amt).min(1.0),
        (bands[1] * amt).min(1.0),
        (bands[2] * amt).min(1.0),
        (selected * amt).min(1.0),
    ]
}

/// An AUT effect's drive value: the routed level when audio-coupled,
/// otherwise a time LFO supplied by the caller.
fn drive(fx: super::state::AutFx, level: f32, lfo: f32) -> f32 {
    if fx.audio {
        level
    } else {
        lfo
    }
}

/// FLK blink probability term: min(1, level*1.5) when audio-coupled, else 1.
fn flicker_drive(fx: super::state::AutFx, level: f32) -> f32 {
    if fx.audio {
        (level * 1.5).min(1.0)
    } else {
        1.0
    }
}

// TLT rocks the composite tilt around the TILT knob — sampling-stage, so it
// applies to EVERY deck type.
fn tilt_wobble(aut: &AutMap, level: f32, t: f32) -> f32 {
    aut.tlt.amt * 0.6 * drive(aut.tlt, level, (t * 0.8).sin())
}

/// What the deck content state machine animates between frames. Staging a
/// deck replaces this (resetting spin/scroll accumulators, like the TS
/// engine's fresh content objects did).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContentAnim {
    Shader,
    Sprite {
        image_aspect: f32,
        spin: f32,
    },
    Model {
        spin: f32,
    },
    Flight {
        through: bool,
        span: f32,
        cam_height: f32,
        scroll: f32,
    },
}

struct SlotAnim {
    /// animateShaderComposite's ROT accumulator; persists across shader
    /// staging, exactly like NativeRenderEngine.compositeSpin.
    composite_spin: f32,
    content: ContentAnim,
}

/// The render thread's per-frame evaluator: owns the audio smoothing state,
/// the per-slot accumulators, and the flicker PRNG.
pub struct Evaluator {
    smoothed: [f32; 4],
    slots: Vec<SlotAnim>,
    rng: fastrand::Rng,
}

impl Default for Evaluator {
    fn default() -> Self {
        Self::new()
    }
}

impl Evaluator {
    pub fn new() -> Self {
        Self {
            smoothed: [0.0; 4],
            slots: (0..SLOT_COUNT)
                .map(|_| SlotAnim {
                    composite_spin: 0.0,
                    content: ContentAnim::Shader,
                })
                .collect(),
            rng: fastrand::Rng::new(),
        }
    }

    /// Swap a slot's content state machine (called from the staging jobs).
    pub fn set_content(&mut self, slot: usize, content: ContentAnim) {
        if let Some(s) = self.slots.get_mut(slot) {
            s.content = content;
        }
    }

    /// One evaluation tick on the render clock. `raw` is the latest raw band
    /// snapshot from the audio thread (zeros when capture is stopped); `dt`
    /// must already be clamped (the render loop caps it at 0.1 like TS).
    pub fn evaluate(
        &mut self,
        msg: &RenderStateMsg,
        raw: [f32; 8],
        t: f32,
        dt: f32,
    ) -> EvaluatedFrame {
        // The four continuous bands get gain then 0.15 lerp per frame; the zip
        // stops at `smoothed`'s length (4), so raw[4..8] are left untouched here.
        for (s, &r) in self.smoothed.iter_mut().zip(raw.iter()) {
            let target = (r * AUDIO_GAIN).min(1.0);
            *s += (target - *s) * SMOOTHING;
        }
        // The beat envelopes [low, mid, high, combined] are already shaped in
        // audio.rs — pass them through with NO gain and NO lerp (the spiky
        // impulses must not be smeared). Deliberate parity exception, mirrored
        // in NativeAudioEngine.update.
        let beats = [raw[4], raw[5], raw[6], raw[7]];

        let aspect = if msg.aspect.is_finite() && msg.aspect > 0.0 {
            msg.aspect
        } else {
            FALLBACK_ASPECT
        };
        let mut frame = EvaluatedFrame {
            aspect,
            xfade: msg.xfade,
            cue_scene: msg.cue_scene,
            ..Default::default()
        };

        let default_slot = SlotState::default();
        for i in 0..SLOT_COUNT {
            let s = msg.slots.get(i).unwrap_or(&default_slot);
            let audio = route_audio(self.smoothed, beats, &s.band, s.amt);
            let level = audio[3];

            let mut base = Base::from_knobs(s);
            if let Some(lp) = s.loop_.as_ref().filter(|l| l.playing) {
                let beats = (lp.blocks * lp.divider).max(0.125);
                let phase = ((t * msg.bpm) / 60.0 / beats) % 1.0;
                apply_loop_overrides(&mut base, lp, phase);
            }

            let aut = &s.aut;
            let anim = &mut self.slots[i];
            let (mut slot, draw) = match &mut anim.content {
                ContentAnim::Shader => (
                    animate_shader_composite(
                        &base,
                        &mut anim.composite_spin,
                        aut,
                        level,
                        t,
                        dt,
                        &mut self.rng,
                    ),
                    DeckDraw::Shader,
                ),
                ContentAnim::Sprite { image_aspect, spin } => (
                    pin_composite_to_base(&base, aut, level, t),
                    DeckDraw::Sprite(animate_sprite_deck(
                        *image_aspect,
                        spin,
                        aut,
                        level,
                        t,
                        dt,
                        base.pos,
                        aspect,
                        &mut self.rng,
                    )),
                ),
                ContentAnim::Model { spin } => (
                    pin_composite_to_base(&base, aut, level, t),
                    DeckDraw::Model(animate_model_deck(
                        spin,
                        aut,
                        level,
                        t,
                        dt,
                        base.pos,
                        base.light,
                        &mut self.rng,
                    )),
                ),
                ContentAnim::Flight {
                    through,
                    span,
                    cam_height,
                    scroll,
                } => (
                    pin_composite_to_base(&base, aut, level, t),
                    DeckDraw::Flight(animate_landscape_deck(
                        *through,
                        *span,
                        *cam_height,
                        scroll,
                        aut,
                        level,
                        t,
                        dt,
                        base.pos,
                        base.light,
                        &mut self.rng,
                    )),
                ),
            };
            slot.layer = s.layer;
            slot.audio = audio;
            // Only sprite/video/model decks expose the tile toggle; shader and
            // landscape/scene (Flight) decks keep mirror-tiling unconditionally.
            slot.tile = match anim.content {
                ContentAnim::Sprite { .. } | ContentAnim::Model { .. } => s.tile,
                ContentAnim::Shader | ContentAnim::Flight { .. } => true,
            };
            frame.slots[i] = SlotFrame {
                uniforms: slot,
                draw,
                // Filters are a post pass on the deck's output — passed through
                // verbatim; the shader reads time/audio for its own animation.
                filter: FilterFrame {
                    kind: filter_kind_index(&s.filter.kind),
                    amount: s.filter.amount,
                    param2: s.filter.param2,
                },
            };
        }
        frame
    }
}

/// Shader decks: AUT modulates the COMPOSITE sampling around the knob base —
/// SCL = zoom pulse, ROT = continuous spin, TLT = tilt rocking, FLK =
/// brightness flicker, DST = sine UV warp, SKW = shear. Base is never
/// mutated, so turning an effect off lands back exactly on the knobs.
fn animate_shader_composite(
    base: &Base,
    spin: &mut f32,
    aut: &AutMap,
    level: f32,
    t: f32,
    dt: f32,
    rng: &mut fastrand::Rng,
) -> Slot {
    let pulse = 1.0 + aut.scl.amt * 0.4 * drive(aut.scl, level, 0.5 + 0.5 * (t * 2.2).sin());
    *spin += dt * aut.rot.amt * (if aut.rot.audio { level * 8.0 } else { 1.6 });
    Slot {
        mix: base.mix * (1.0 - aut.flk.amt * flicker_drive(aut.flk, level) * rng.f32()),
        scale: base.scale * pulse,
        size: base.size,
        fx: [
            base.fx[0] + *spin + tilt_wobble(aut, level, t),
            base.fx[1],
            base.fx[2],
            base.fx[3],
        ],
        warp: [
            aut.dst.amt * drive(aut.dst, level, 0.6 + 0.4 * (t * 1.3).sin()),
            aut.skw.amt * 0.7 * drive(aut.skw, level, (t * 0.9).sin()),
        ],
        ..Default::default()
    }
}

/// Non-shader decks animate in-scene, so their composite params stay pinned
/// to the knob values — except TLT, which is composite-level for every type.
fn pin_composite_to_base(base: &Base, aut: &AutMap, level: f32, t: f32) -> Slot {
    Slot {
        mix: base.mix,
        scale: base.scale,
        size: base.size,
        fx: [
            base.fx[0] + tilt_wobble(aut, level, t),
            base.fx[1],
            base.fx[2],
            base.fx[3],
        ],
        warp: [0.0, 0.0],
        ..Default::default()
    }
}

/// animateSpriteDeck + updateSpriteLayout + the NativeRenderEngine matrix
/// composition: container (1/viewAspect x-scale, OUTSIDE the rotation) x
/// rotation x scale, plus the bob translation, as one 2x2 + translation.
#[allow(clippy::too_many_arguments)]
fn animate_sprite_deck(
    image_aspect: f32,
    spin: &mut f32,
    aut: &AutMap,
    level: f32,
    t: f32,
    dt: f32,
    pos: [f32; 2],
    view_aspect: f32,
    rng: &mut fastrand::Rng,
) -> SpriteDraw {
    // updateSpriteLayout: contain-fit to ~85% of the frame in aspect-isotropic
    // units; the container's x-scale cancels the screen's NDC stretch.
    let cx = 1.0 / view_aspect;
    let h = 1.7f32.min(1.7 * view_aspect / image_aspect);
    let (base_w, base_h) = (h * image_aspect, h);

    let pulse = 1.0 + aut.scl.amt * 0.6 * drive(aut.scl, level, 0.5 + 0.5 * (t * 2.2).sin());
    *spin += dt * aut.rot.amt * (if aut.rot.audio { level * 8.0 } else { 1.6 });

    let (sx, sy) = (base_w * pulse, base_h * pulse);
    let (px, py) = (pos[0], pos[1] + (t * 0.8).sin() * 0.04);
    let (sin, cos) = spin.sin_cos();
    SpriteDraw {
        m: [cx * cos * sx, cx * -sin * sy, sin * sx, cos * sy],
        t: [cx * px, py],
        distort: aut.dst.amt * drive(aut.dst, level, 0.6 + 0.4 * (t * 1.3).sin()),
        skew: aut.skw.amt * 0.7 * drive(aut.skw, level, (t * 0.9).sin()),
        // FLK as opacity, not visibility — sprites blink via alpha
        opacity: 1.0 - aut.flk.amt * flicker_drive(aut.flk, level) * rng.f32(),
        visible: true,
    }
}

/// FLK = whole-frame blink. Random is only drawn when amt > 0 (JS `&&`
/// short-circuits before Math.random there too).
fn blink_hidden(aut: &AutMap, level: f32, rng: &mut fastrand::Rng) -> bool {
    aut.flk.amt > 0.0 && rng.f32() < aut.flk.amt * flicker_drive(aut.flk, level) * 0.5
}

/// animateModelDeck: ROT spin + nod, SCL pulse, DST jelly squash-and-stretch,
/// SKW side lean, FLK whole-frame blink. Rotation order XYZ, like THREE.
#[allow(clippy::too_many_arguments)]
fn animate_model_deck(
    spin: &mut f32,
    aut: &AutMap,
    level: f32,
    t: f32,
    dt: f32,
    pos: [f32; 2],
    light: [f32; 2],
    rng: &mut fastrand::Rng,
) -> ModelDraw {
    // ROT drives the spin entirely — amt 0 parks the model where it is
    *spin += dt * aut.rot.amt * (if aut.rot.audio { level * 8.0 } else { 1.6 });
    let pulse = 1.0 + aut.scl.amt * 0.5 * drive(aut.scl, level, 0.5 + 0.5 * (t * 2.2).sin());
    // DST = jelly squash-and-stretch (material-agnostic "distortion")
    let wobble = aut.dst.amt * 0.35 * drive(aut.dst, level, 0.6 + 0.4 * (t * 1.3).sin());

    // the gentle nod scales with ROT too, so a parked model is truly still;
    // SKW = side lean (true shear isn't expressible in TRS transforms)
    let rx = aut.rot.amt * (t * 0.3).sin() * 0.2;
    let rz = aut.skw.amt * 0.5 * drive(aut.skw, level, (t * 0.9).sin());
    // the core bakes normalization into the geometry, so baseScale is 1
    let base_scale = 1.0;
    ModelDraw {
        pos: [pos[0], pos[1], 0.0],
        quat: math3d::quat_from_euler_xyz(rx, *spin, rz),
        scale: [
            base_scale * pulse * (1.0 + wobble * (t * 7.0).sin()),
            base_scale * pulse * (1.0 - wobble * (t * 7.0 + 1.0).sin()),
            base_scale * pulse * (1.0 + wobble * (t * 6.0).cos()),
        ],
        brightness: light[0],
        light_angle: light[1],
        visible: !blink_hidden(aut, level, rng),
    }
}

/// animateLandscapeDeck: constant forward scroll (always audio-boosted), tile
/// leapfrog, SCL terrain breathing, and the AUT effects in camera language —
/// ROT = yaw sway, DST = shake, SKW = roll (added AFTER lookAt), FLK = blink.
#[allow(clippy::too_many_arguments)]
fn animate_landscape_deck(
    through: bool,
    span: f32,
    cam_height: f32,
    scroll: &mut f32,
    aut: &AutMap,
    level: f32,
    t: f32,
    dt: f32,
    pos: [f32; 2],
    light: [f32; 2],
    rng: &mut fastrand::Rng,
) -> FlightDraw {
    let base_speed = span / 9.0; // one tile every ~9s at rest
    let two_span = 2.0 * span;
    // Wrapping keeps f32 precision over long sets; tile z only ever reads
    // scroll modulo 2*span, so this is observably identical to TS.
    *scroll = (*scroll + dt * base_speed * (1.0 + level * 1.5)) % two_span;
    // tiles march toward the camera (+z) and leapfrog back when passed
    let tile_z = [
        *scroll % two_span - span,
        (*scroll + span) % two_span - span,
    ];
    // SCL = terrain breathing; mirrored tiles keep their negative z scale
    let pulse = 1.0 + aut.scl.amt * 0.6 * drive(aut.scl, level, 0.5 + 0.5 * (t * 1.7).sin());

    // POS pans the whole camera track: x slides it sideways (lookAt follows
    // so it translates rather than turns), y raises/lowers the flight height.
    let sway = aut.rot.amt * 0.6 * drive(aut.rot, level, (t * 0.4).sin());
    let shake = aut.dst.amt * drive(aut.dst, level, 0.5 + 0.5 * (t * 1.3).sin());
    let bob_x = (t * 0.23).sin() * 0.4 + shake * 0.12 * (t * 31.0).sin();
    let bob_y = (t * 0.6).sin() * 0.08 + shake * 0.1 * (t * 27.0).cos();
    let cam_x = pos[0] + bob_x;
    // Fly-over is floored so the camera never dives under the terrain;
    // fly-through (tunnels) aims straight down the axis instead.
    let (cam_y, target) = if through {
        (
            cam_height + pos[1] + bob_y,
            [pos[0] + sway * 3.0, cam_height + pos[1], -6.0],
        )
    } else {
        (
            (cam_height + pos[1] + bob_y).max(0.1),
            [
                pos[0] + sway * 3.0,
                ((cam_height + pos[1]) * 0.45).max(0.05),
                -6.0,
            ],
        )
    };
    // z is fixed at the staged vantage; animate only steers x/y
    let cam = [cam_x, cam_y, span * 0.45];
    // SKW = roll lean, applied after lookAt so it isn't overwritten
    let roll = aut.skw.amt * 0.4 * drive(aut.skw, level, (t * 0.9).sin());
    FlightDraw {
        cam,
        quat: math3d::look_at_quat_with_roll(cam, target, roll),
        tile_z,
        tile_scale_y: pulse,
        brightness: light[0],
        light_angle: light[1],
        visible: !blink_hidden(aut, level, rng),
        fov_deg: FLIGHT_FOV,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::state::AutFx;

    fn pt(t: f32, v: f32, bend: f32) -> LanePoint {
        LanePoint { t, v, bend }
    }

    fn flat_lane(v: f32) -> Vec<LanePoint> {
        vec![pt(0.0, v, 0.0), pt(1.0, v, 0.0)]
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    // ---- sampleLane parity with src/lib/loopControls.test.js ----

    #[test]
    fn sample_lane_holds_flat_lanes_at_their_value() {
        let lane = flat_lane(0.7);
        for u in [0.0, 0.25, 0.5, 1.0] {
            assert!(close(sample_lane(&lane, u), 0.7));
        }
    }

    #[test]
    fn sample_lane_interpolates_linearly_at_bend_zero() {
        let lane = [pt(0.0, 0.0, 0.0), pt(1.0, 1.0, 0.0)];
        assert!(close(sample_lane(&lane, 0.25), 0.25));
        assert!(close(sample_lane(&lane, 0.5), 0.5));
    }

    #[test]
    fn sample_lane_bend_plus_eases_late_minus_eases_early() {
        let late = [pt(0.0, 0.0, 1.0), pt(1.0, 1.0, 0.0)];
        let early = [pt(0.0, 0.0, -1.0), pt(1.0, 1.0, 0.0)];
        assert!(close(sample_lane(&late, 0.5), 0.5f32.powi(4))); // u^4
        assert!(sample_lane(&late, 0.5) < 0.2);
        assert!(close(sample_lane(&early, 0.5), 0.5f32.powf(0.25))); // u^0.25
        assert!(sample_lane(&early, 0.5) > 0.8);
        assert!(close(sample_lane(&late, 0.0), 0.0));
        assert!(close(sample_lane(&late, 1.0), 1.0));
    }

    #[test]
    fn sample_lane_walks_multi_segment_lanes_with_per_segment_bends() {
        let lane = [pt(0.0, 0.0, 0.0), pt(0.5, 1.0, 1.0), pt(1.0, 0.0, 0.0)];
        assert!(close(sample_lane(&lane, 0.25), 0.5)); // linear up
        assert!(close(sample_lane(&lane, 0.5), 1.0));
        assert!(close(sample_lane(&lane, 0.75), 1.0 - 0.5f32.powi(4))); // eased down
    }

    #[test]
    fn sample_lane_holds_edges_and_clamps_phase() {
        let lane = [pt(0.25, 0.2, 0.0), pt(0.75, 0.9, 0.0)];
        assert!(close(sample_lane(&lane, 0.0), 0.2));
        assert!(close(sample_lane(&lane, 1.0), 0.9));
        assert!(close(sample_lane(&lane, -5.0), 0.2));
        assert_eq!(sample_lane(&[], 0.5), 0.0);
    }

    #[test]
    fn sample_lane_zero_width_segment_does_not_divide_by_zero() {
        let lane = [pt(0.0, 0.0, 0.0), pt(0.5, 0.2, 0.0), pt(0.5, 1.0, 0.0)];
        assert!(sample_lane(&lane, 0.5).is_finite());
    }

    // ---- evaluation harness ----

    fn slot_msg(slot: SlotState) -> RenderStateMsg {
        RenderStateMsg {
            slots: vec![slot],
            ..Default::default()
        }
    }

    fn aut_one(make: impl Fn(&mut AutMap)) -> AutMap {
        let mut aut = AutMap::default();
        make(&mut aut);
        aut
    }

    const ON: AutFx = AutFx {
        amt: 1.0,
        audio: false,
    };

    // ---- loop overrides ----

    #[test]
    fn fader_lane_multiplies_knob_mix_and_scale_lane_lerps() {
        // mirrors NativeRenderEngine.test.js "fader lane multiplies..."
        let mut eval = Evaluator::new();
        let msg = slot_msg(SlotState {
            mix: 0.5,
            scale: 2.0,
            loop_: Some(LoopState {
                playing: true,
                blocks: 1.0,
                divider: 4.0,
                lanes: [
                    ("opacity".to_string(), flat_lane(0.5)),
                    ("scale".to_string(), flat_lane(1.0)),
                ]
                .into(),
            }),
            ..Default::default()
        });
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.016);
        let u = frame.slots[0].uniforms;
        assert!(close(u.mix, 0.25)); // 0.5 knob * 0.5 lane
        assert!(close(u.scale, 3.0)); // lane 1 -> top of 0.25..3
    }

    #[test]
    fn loop_lanes_override_absolutely_with_contract_ranges() {
        let mut eval = Evaluator::new();
        let lanes: std::collections::HashMap<String, Vec<LanePoint>> = [
            "sizeX",
            "sizeY",
            "posX",
            "posY",
            "tilt",
            "contrast",
            "hue",
            "sat",
            "brightness",
            "lightAngle",
        ]
        .iter()
        .map(|id| (id.to_string(), flat_lane(1.0)))
        .collect();
        let msg = slot_msg(SlotState {
            loop_: Some(LoopState {
                playing: true,
                blocks: 1.0,
                divider: 1.0,
                lanes,
            }),
            ..Default::default()
        });
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.016);
        let u = frame.slots[0].uniforms;
        assert!(close(u.size[0], 1.0) && close(u.size[1], 1.0)); // 0.05..1 at v=1
        assert!(close(u.fx[0], PI)); // tilt -PI..PI
        assert!(close(u.fx[1], 2.0)); // contrast 0..2
        assert!(close(u.fx[2], PI)); // hue -PI..PI
        assert!(close(u.fx[3], 2.0)); // sat 0..2

        // v=0 lands on the bottom of each range (posX/posY -2, brightness 0)
        let lanes: std::collections::HashMap<String, Vec<LanePoint>> =
            [("scale", 0.0f32), ("sizeX", 0.0), ("posX", 0.0)]
                .iter()
                .map(|(id, v)| (id.to_string(), flat_lane(*v)))
                .collect();
        let mut model_slot = SlotState {
            loop_: Some(LoopState {
                playing: true,
                blocks: 1.0,
                divider: 1.0,
                lanes,
            }),
            ..Default::default()
        };
        let frame = eval.evaluate(&slot_msg(model_slot.clone()), [0.0; 8], 0.0, 0.016);
        let u = frame.slots[0].uniforms;
        assert!(close(u.scale, 0.25));
        assert!(close(u.size[0], 0.05));

        // posX lane reaches the model position (loop pos overrides the knob)
        let mut eval = Evaluator::new();
        eval.set_content(0, ContentAnim::Model { spin: 0.0 });
        model_slot
            .loop_
            .as_mut()
            .unwrap()
            .lanes
            .insert("posY".into(), flat_lane(1.0));
        let frame = eval.evaluate(&slot_msg(model_slot), [0.0; 8], 0.0, 0.016);
        let DeckDraw::Model(m) = frame.slots[0].draw else {
            panic!("expected a model draw");
        };
        assert!(close(m.pos[0], -2.0)); // posX v=0 -> -2
        assert!(close(m.pos[1], 2.0)); // posY v=1 -> 2
    }

    #[test]
    fn stopping_the_loop_lands_back_on_the_knob_values() {
        let mut eval = Evaluator::new();
        let mut slot = SlotState {
            mix: 0.5,
            ..Default::default()
        };
        slot.loop_ = Some(LoopState {
            playing: true,
            blocks: 1.0,
            divider: 4.0,
            lanes: [("opacity".to_string(), flat_lane(0.0))].into(),
        });
        let frame = eval.evaluate(&slot_msg(slot.clone()), [0.0; 8], 0.0, 0.016);
        assert!(close(frame.slots[0].uniforms.mix, 0.0));

        slot.loop_ = None;
        let frame = eval.evaluate(&slot_msg(slot), [0.0; 8], 0.1, 0.016);
        assert!(close(frame.slots[0].uniforms.mix, 0.5));
    }

    #[test]
    fn loop_phase_runs_on_bpm_blocks_and_divider() {
        // ramp lane 0->1; bpm 120 = 2 beats/s; blocks*divider = 4 beats = 2s.
        let mut eval = Evaluator::new();
        let slot = SlotState {
            loop_: Some(LoopState {
                playing: true,
                blocks: 4.0,
                divider: 1.0,
                lanes: [(
                    "contrast".to_string(),
                    vec![pt(0.0, 0.0, 0.0), pt(1.0, 1.0, 0.0)],
                )]
                .into(),
            }),
            ..Default::default()
        };
        let msg = slot_msg(slot);
        // t = 0.5s -> phase 0.25 -> contrast lerp(0, 2, 0.25) = 0.5
        let frame = eval.evaluate(&msg, [0.0; 8], 0.5, 0.016);
        assert!(close(frame.slots[0].uniforms.fx[1], 0.5));
        // t = 2.5s wraps -> phase 0.25 again
        let frame = eval.evaluate(&msg, [0.0; 8], 2.5, 0.016);
        assert!(close(frame.slots[0].uniforms.fx[1], 0.5));
        // beats floor: blocks*divider = 0.0625 clamps to 0.125
        let mut eval = Evaluator::new();
        let slot = SlotState {
            loop_: Some(LoopState {
                playing: true,
                blocks: 0.125,
                divider: 0.5,
                lanes: [(
                    "contrast".to_string(),
                    vec![pt(0.0, 0.0, 0.0), pt(1.0, 1.0, 0.0)],
                )]
                .into(),
            }),
            ..Default::default()
        };
        // 0.125 beats at 120bpm = 62.5ms loop; t = 31.25ms -> phase 0.5
        let frame = eval.evaluate(&slot_msg(slot), [0.0; 8], 0.03125, 0.016);
        assert!(close(frame.slots[0].uniforms.fx[1], 1.0));
    }

    // ---- audio routing (NativeRenderEngine.test.js values) ----

    #[test]
    fn route_audio_scales_all_bands_and_band_drives_level() {
        let bands = [0.5, 0.2, 0.9, 0.4];
        let no_beat = [0.0; 4];
        let high = route_audio(bands, no_beat, "high", 2.0);
        assert_eq!(high[0], 1.0); // low 0.5*2 clamped
        assert!(close(high[1], 0.4)); // mid 0.2*2
        assert_eq!(high[2], 1.0); // high 0.9*2 clamped
        assert_eq!(high[3], 1.0); // level <- high band, 0.9*2 clamped

        let level = route_audio(bands, no_beat, "level", 0.5);
        assert!(close(level[0], 0.25));
        assert!(close(level[3], 0.2)); // level band * 0.5

        // unknown band falls back to level, like `audio[band] ?? audio.level`
        let odd = route_audio(bands, no_beat, "weird", 1.0);
        assert!(close(odd[3], 0.4));
    }

    #[test]
    fn route_audio_beat_layers_select_envelopes() {
        let bands = [0.5, 0.2, 0.9, 0.4];
        let beats = [0.3, 0.6, 0.9, 0.8]; // low, mid, high, combined
                                          // Each layer (and the combined) routes its own envelope into level.
        assert!(close(route_audio(bands, beats, "beat", 1.0)[3], 0.8));
        assert!(close(route_audio(bands, beats, "beat-low", 1.0)[3], 0.3));
        assert!(close(route_audio(bands, beats, "beat-mid", 1.0)[3], 0.6));
        assert!(close(route_audio(bands, beats, "beat-high", 1.0)[3], 0.9));
        // amt scales+clamps the routed level; the band channels carry the bands
        // (scaled by amt), never the beat envelopes.
        let scaled = route_audio(bands, beats, "beat-low", 2.0);
        assert_eq!(scaled[3], 0.6); // beatLow 0.3*2
        assert_eq!(scaled[0], 1.0); // low band 0.5*2 clamped
        assert!(close(scaled[1], 0.4)); // mid band 0.2*2
    }

    #[test]
    fn beat_envelope_is_not_lerp_smoothed() {
        let mut eval = Evaluator::new();
        let mut slot = SlotState::default();
        slot.band = "beat-low".into();
        slot.amt = 1.0;
        let msg = slot_msg(slot);
        // A one-shot full beat (raw[4] = beatLow) reaches level immediately — no
        // gain, no ramp — unlike the continuous bands (see audio_smoothing...).
        let frame = eval.evaluate(&msg, [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], 0.0, 0.016);
        assert!(close(frame.slots[0].uniforms.audio[3], 1.0));
    }

    #[test]
    fn audio_smoothing_applies_gain_then_per_frame_lerp() {
        let mut eval = Evaluator::new();
        let msg = slot_msg(SlotState::default()); // band level, amt 1
        let frame = eval.evaluate(&msg, [0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0], 0.0, 0.016);
        // target = min(1, 0.5*1.4) = 0.7; first lerp step = 0.7*0.15
        assert!(close(frame.slots[0].uniforms.audio[3], 0.7 * 0.15));
        let frame = eval.evaluate(&msg, [0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0], 0.016, 0.016);
        let expect = 0.105 + (0.7 - 0.105) * 0.15;
        assert!(close(frame.slots[0].uniforms.audio[3], expect));
        // capture stopped -> zeros decay through the lerp
        let frame = eval.evaluate(&msg, [0.0; 8], 0.032, 0.016);
        assert!(close(frame.slots[0].uniforms.audio[3], expect * 0.85));
    }

    // ---- slot layout + composite pin/animate ----

    #[test]
    fn knob_values_pass_through_the_slot_uniforms() {
        // mirrors NativeRenderEngine.test.js "packs knob values..."
        let mut eval = Evaluator::new();
        let msg = slot_msg(SlotState {
            mix: 0.8,
            scale: 1.5,
            size_x: 0.6,
            size_y: 0.4,
            tilt: 0.1,
            contrast: 1.2,
            hue: -0.3,
            sat: 0.9,
            layer: 2.0,
            ..Default::default()
        });
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.016);
        let u = frame.slots[0].uniforms;
        assert!(close(u.mix, 0.8));
        assert!(close(u.scale, 1.5)); // no AUT -> base
        assert_eq!(u.size, [0.6, 0.4]);
        assert_eq!(u.fx, [0.1, 1.2, -0.3, 0.9]);
        assert_eq!(u.warp, [0.0, 0.0]); // idle
        assert_eq!(u.layer, 2.0);
        // untouched slots stay neutral defaults
        assert_eq!(frame.slots[5].uniforms, Slot::default());
    }

    #[test]
    fn shader_spin_accumulates_at_fixed_dt_and_non_shader_pins() {
        let mut eval = Evaluator::new();
        let slot = SlotState {
            scale: 1.4,
            aut: aut_one(|a| {
                a.rot = ON;
                a.scl = ON;
                a.dst = ON;
            }),
            ..Default::default()
        };
        let msg = slot_msg(slot);
        // shader composite: spin = sum(dt * 1.6) at t=0 LFO phases
        let frame1 = eval.evaluate(&msg, [0.0; 8], 0.0, 0.025);
        assert!(close(frame1.slots[0].uniforms.fx[0], 0.025 * 1.6));
        let frame2 = eval.evaluate(&msg, [0.0; 8], 0.0, 0.025);
        assert!(close(frame2.slots[0].uniforms.fx[0], 0.05 * 1.6));
        // SCL pulses the composite scale at t=0: 1 + 0.4*0.5 = 1.2
        assert!(close(frame2.slots[0].uniforms.scale, 1.4 * 1.2));
        // DST warps the composite at t=0: 0.6
        assert!(close(frame2.slots[0].uniforms.warp[0], 0.6));

        // the same AUT on a model deck pins the composite (no zoom, no warp)
        let mut eval = Evaluator::new();
        eval.set_content(0, ContentAnim::Model { spin: 0.0 });
        let frame = eval.evaluate(&msg, [0.0; 8], 1.0, 0.016);
        assert!(close(frame.slots[0].uniforms.scale, 1.4));
        assert_eq!(frame.slots[0].uniforms.warp, [0.0, 0.0]);
    }

    #[test]
    fn model_spin_accumulates_and_blink_is_deterministic_when_off() {
        let mut eval = Evaluator::new();
        eval.set_content(2, ContentAnim::Model { spin: 0.0 });
        let mut slots: Vec<SlotState> = (0..3).map(|_| SlotState::default()).collect();
        slots[2] = SlotState {
            aut: aut_one(|a| a.rot = ON),
            brightness: 1.5,
            light_angle: 0.7,
            ..Default::default()
        };
        let msg = RenderStateMsg {
            slots,
            ..Default::default()
        };
        // two ticks at t=0: ry = 2 * dt * 1.6; rx = rot.amt*sin(0)*0.2 = 0
        eval.evaluate(&msg, [0.0; 8], 0.0, 0.5);
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.5);
        let DeckDraw::Model(m) = frame.slots[2].draw else {
            panic!("expected a model draw");
        };
        let expect = math3d::quat_from_euler_xyz(0.0, 1.6, 0.0);
        for (a, b) in m.quat.iter().zip(expect) {
            assert!(close(*a, b));
        }
        assert_eq!(m.scale, [1.0, 1.0, 1.0]); // no SCL/DST -> unit jelly
        assert!(close(m.brightness, 1.5));
        assert!(close(m.light_angle, 0.7));
        assert!(m.visible); // flk.amt 0 never blinks
    }

    #[test]
    fn sprite_layout_and_matrix_composition_for_known_aspect() {
        // mirrors NativeRenderEngine.test.js: viewAspect 2 / imageAspect 2
        // -> h = min(1.7, 1.7*2/2) = 1.7, baseW = 3.4, container cx = 0.5
        let mut eval = Evaluator::new();
        eval.set_content(
            1,
            ContentAnim::Sprite {
                image_aspect: 2.0,
                spin: 0.0,
            },
        );
        let msg = RenderStateMsg {
            aspect: 2.0,
            slots: vec![SlotState::default(), SlotState::default()],
            ..Default::default()
        };
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.016);
        let DeckDraw::Sprite(s) = frame.slots[1].draw else {
            panic!("expected a sprite draw");
        };
        assert!(close(s.m[0], 0.5 * 3.4)); // m00 = cx*cos*sx = 1.7
        assert!(close(s.m[1], 0.0)); // m01
        assert!(close(s.m[2], 0.0)); // m10
        assert!(close(s.m[3], 1.7)); // m11 = cos*sy
        assert_eq!(s.t, [0.0, 0.0]); // pos 0, bob sin(0) = 0
        assert!(close(s.opacity, 1.0)); // no flicker
        assert!(s.visible);

        // a 90° spin swaps the axes through the container compensation
        eval.set_content(
            1,
            ContentAnim::Sprite {
                image_aspect: 2.0,
                spin: std::f32::consts::FRAC_PI_2,
            },
        );
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.0);
        let DeckDraw::Sprite(s) = frame.slots[1].draw else {
            panic!("expected a sprite draw");
        };
        assert!(close(s.m[0], 0.0));
        assert!(close(s.m[1], 0.5 * -1.7)); // cx * -sin * sy
        assert!(close(s.m[2], 3.4)); // sin * sx
        assert!(close(s.m[3], 0.0));

        // wide view, square image: h capped at 1.7
        eval.set_content(
            1,
            ContentAnim::Sprite {
                image_aspect: 1.0,
                spin: 0.0,
            },
        );
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.016);
        let DeckDraw::Sprite(s) = frame.slots[1].draw else {
            panic!("expected a sprite draw");
        };
        assert!(close(s.m[0], 0.5 * 1.7));
        assert!(close(s.m[3], 1.7));
    }

    #[test]
    fn landscape_scroll_accumulates_with_tile_leapfrog_math() {
        // mirrors NativeRenderEngine.test.js "staged landscape writes mode 3"
        let mut eval = Evaluator::new();
        eval.set_content(
            0,
            ContentAnim::Flight {
                through: false,
                span: 9.0,
                cam_height: 1.2,
                scroll: 0.0,
            },
        );
        let msg = slot_msg(SlotState::default());
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.5);
        let DeckDraw::Flight(f) = frame.slots[0].draw else {
            panic!("expected a flight draw");
        };
        // scroll = 0.5 * (9/9) * 1 = 0.5 -> tile z = (0.5 % 18) - 9
        assert!(close(f.tile_z[0], 0.5 - 9.0));
        assert!(close(f.tile_z[1], 9.5 - 9.0));
        assert!(close(f.cam[2], 9.0 * 0.45)); // camZ fixed at span*0.45
        assert_eq!(f.fov_deg, 64.0);
        assert!(close(f.tile_scale_y, 1.0)); // no SCL
        assert!(f.visible);

        // audio boost: level 1 scrolls 2.5x faster
        let mut eval = Evaluator::new();
        eval.set_content(
            0,
            ContentAnim::Flight {
                through: false,
                span: 9.0,
                cam_height: 1.2,
                scroll: 0.0,
            },
        );
        // saturate the smoother so level == 1
        for _ in 0..200 {
            eval.evaluate(&msg, [1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0], 0.0, 0.016);
        }
        let before = match eval
            .evaluate(&msg, [1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0], 0.0, 0.0)
            .slots[0]
            .draw
        {
            DeckDraw::Flight(f) => f.tile_z[0],
            _ => panic!(),
        };
        let after = match eval
            .evaluate(&msg, [1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0], 0.0, 0.5)
            .slots[0]
            .draw
        {
            DeckDraw::Flight(f) => f.tile_z[0],
            _ => panic!(),
        };
        assert!(close(after - before, 0.5 * 2.5));
    }

    #[test]
    fn flight_camera_looks_down_track_and_floors_fly_over_height() {
        // fly-over with the camera pushed below ground: y floors at 0.1 and
        // the lookAt target y floors at 0.05.
        let mut eval = Evaluator::new();
        eval.set_content(
            0,
            ContentAnim::Flight {
                through: false,
                span: 9.0,
                cam_height: 0.5,
                scroll: 0.0,
            },
        );
        let msg = slot_msg(SlotState {
            pos_y: -5.0,
            ..Default::default()
        });
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.016);
        let DeckDraw::Flight(f) = frame.slots[0].draw else {
            panic!("expected a flight draw");
        };
        assert!(close(f.cam[1], 0.1));
        // expected orientation: lookAt from cam to (0, 0.05, -6), no roll
        let expect = math3d::look_at_quat_with_roll(f.cam, [0.0, 0.05, -6.0], 0.0);
        for (a, b) in f.quat.iter().zip(expect) {
            assert!(close(*a, b));
        }

        // fly-through keeps the axis target and adds SKW as pure roll
        let mut eval = Evaluator::new();
        eval.set_content(
            0,
            ContentAnim::Flight {
                through: true,
                span: 9.0,
                cam_height: 0.0,
                scroll: 0.0,
            },
        );
        let msg = slot_msg(SlotState {
            aut: aut_one(|a| {
                a.skw = AutFx {
                    amt: 1.0,
                    audio: true,
                }
            }),
            ..Default::default()
        });
        // level 0 (audio-coupled, silence) -> roll 0; bobs at t=0 are 0
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.016);
        let DeckDraw::Flight(f) = frame.slots[0].draw else {
            panic!("expected a flight draw");
        };
        assert!(close(f.cam[1], 0.0)); // no floor for fly-through
        let expect = math3d::look_at_quat_with_roll(f.cam, [0.0, 0.0, -6.0], 0.0);
        for (a, b) in f.quat.iter().zip(expect) {
            assert!(close(*a, b));
        }
    }

    #[test]
    fn flicker_dims_sprites_and_blinks_models() {
        let mut eval = Evaluator::new();
        eval.set_content(
            0,
            ContentAnim::Sprite {
                image_aspect: 1.0,
                spin: 0.0,
            },
        );
        let msg = slot_msg(SlotState {
            aut: aut_one(|a| a.flk = ON),
            ..Default::default()
        });
        // full-amt flicker: opacity = 1 - rand, always within [0, 1]
        let mut varied = false;
        let mut last = None;
        for i in 0..32 {
            let frame = eval.evaluate(&msg, [0.0; 8], i as f32 * 0.016, 0.016);
            let DeckDraw::Sprite(s) = frame.slots[0].draw else {
                panic!("expected a sprite draw");
            };
            assert!((0.0..=1.0).contains(&s.opacity));
            assert!(s.visible); // sprites blink via opacity, not visibility
            if let Some(prev) = last {
                varied |= (s.opacity - prev) != 0.0;
            }
            last = Some(s.opacity);
        }
        assert!(varied, "flicker should vary the sprite opacity");

        // models: ~half the frames hide at amt 1 (probability amt*0.5)
        let mut eval = Evaluator::new();
        eval.set_content(0, ContentAnim::Model { spin: 0.0 });
        let mut hidden = 0;
        for i in 0..400 {
            let frame = eval.evaluate(&msg, [0.0; 8], i as f32 * 0.016, 0.016);
            let DeckDraw::Model(m) = frame.slots[0].draw else {
                panic!("expected a model draw");
            };
            if !m.visible {
                hidden += 1;
            }
        }
        assert!(
            (100..300).contains(&hidden),
            "blink rate should be ~50%, got {hidden}/400"
        );
    }

    #[test]
    fn staging_resets_content_accumulators() {
        let mut eval = Evaluator::new();
        eval.set_content(
            0,
            ContentAnim::Flight {
                through: false,
                span: 9.0,
                cam_height: 1.2,
                scroll: 0.0,
            },
        );
        let msg = slot_msg(SlotState::default());
        eval.evaluate(&msg, [0.0; 8], 0.0, 0.5);
        // re-staging hands the evaluator a fresh accumulator
        eval.set_content(
            0,
            ContentAnim::Flight {
                through: false,
                span: 9.0,
                cam_height: 1.2,
                scroll: 0.0,
            },
        );
        let frame = eval.evaluate(&msg, [0.0; 8], 0.0, 0.0);
        let DeckDraw::Flight(f) = frame.slots[0].draw else {
            panic!("expected a flight draw");
        };
        assert!(close(f.tile_z[0], -9.0)); // scroll back to 0
    }

    #[test]
    fn missing_slots_evaluate_as_default_state() {
        let mut eval = Evaluator::new();
        let msg = RenderStateMsg::default(); // no slots at all
        let frame = eval.evaluate(&msg, [0.0; 8], 1.0, 0.016);
        for slot in &frame.slots {
            assert_eq!(slot.uniforms, Slot::default());
            assert_eq!(slot.draw, DeckDraw::Shader);
        }
        // degenerate aspect falls back rather than NaN-ing the layout
        let msg = RenderStateMsg {
            aspect: f32::NAN,
            ..Default::default()
        };
        assert!(close(
            eval.evaluate(&msg, [0.0; 8], 0.0, 0.016).aspect,
            FALLBACK_ASPECT
        ));
    }
}
