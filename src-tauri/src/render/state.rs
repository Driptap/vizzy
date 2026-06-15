// The `render_state` IPC payload: the TS client pushes STATE on change
// (knobs, layers, audio routing, AUT config, loop lanes); the render thread
// evaluates it every frame on its own clock. Serde is camelCase and every
// field is defaulted so a sparse payload reads as the staged default state.
use std::collections::HashMap;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderStateMsg {
    pub aspect: f32,
    pub xfade: f32,
    pub cue_scene: u32,
    pub bpm: f32,
    /// Up to 8 slots; missing entries read as `SlotState::default()`.
    pub slots: Vec<SlotState>,
}

impl Default for RenderStateMsg {
    fn default() -> Self {
        Self {
            aspect: 16.0 / 9.0,
            xfade: 0.0,
            cue_scene: 0,
            bpm: 120.0,
            slots: Vec::new(),
        }
    }
}

/// One deck strip's full control state. Angles (tilt, hue, light_angle) are
/// radians; layer is 1..4; band is "low" | "mid" | "high" | "level".
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SlotState {
    pub mix: f32,
    pub scale: f32,
    pub size_x: f32,
    pub size_y: f32,
    pub tilt: f32,
    pub contrast: f32,
    pub hue: f32,
    pub sat: f32,
    pub layer: f32,
    pub pos_x: f32,
    pub pos_y: f32,
    pub brightness: f32,
    pub light_angle: f32,
    pub band: String,
    pub amt: f32,
    pub aut: AutMap,
    pub filter: FilterState,
    #[serde(rename = "loop")]
    pub loop_: Option<LoopState>,
    /// Present only on video decks; drives the per-frame playhead.
    pub video: Option<VideoPlayback>,
}

/// Per-deck video playback controls, pushed from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoPlayback {
    /// Playback speed magnitude (0..4).
    pub rate: f32,
    /// Play backward.
    pub reverse: bool,
    /// "loop" | "once" | "ping" (ping = ping-pong).
    pub loop_mode: String,
    /// Lock the clip loop to the global tempo, stretched to `beat_div` beats.
    pub beat_sync: bool,
    pub beat_div: f32,
    /// On each detected beat: restart the clip.
    pub beat_jump: bool,
    /// Modulate playback speed with the beat envelope.
    pub beat_rate: bool,
    /// Flip play direction on each beat.
    pub beat_flip: bool,
}

impl Default for VideoPlayback {
    fn default() -> Self {
        Self {
            rate: 1.0,
            reverse: false,
            loop_mode: "loop".into(),
            beat_sync: false,
            beat_div: 4.0,
            beat_jump: false,
            beat_rate: false,
            beat_flip: false,
        }
    }
}

/// The post filter on this deck's visible output. `kind` is one of the
/// FILTER_KINDS ids ("none" = off); `amount` and `param2` are the two generic
/// 0..1 controls the filter shader interprets per kind.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterState {
    pub kind: String,
    pub amount: f32,
    pub param2: f32,
}

impl Default for FilterState {
    fn default() -> Self {
        Self {
            kind: "none".into(),
            amount: 0.5,
            param2: 0.5,
        }
    }
}

impl Default for SlotState {
    fn default() -> Self {
        Self {
            mix: 0.0,
            scale: 1.0,
            size_x: 1.0,
            size_y: 1.0,
            tilt: 0.0,
            contrast: 1.0,
            hue: 0.0,
            sat: 1.0,
            layer: 4.0,
            pos_x: 0.0,
            pos_y: 0.0,
            brightness: 1.0,
            light_angle: 0.0,
            band: "level".into(),
            amt: 1.0,
            aut: AutMap::default(),
            filter: FilterState::default(),
            loop_: None,
            video: None,
        }
    }
}

/// The six AUT effects, each {amt 0..1, audio-coupled?}.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct AutMap {
    pub scl: AutFx,
    pub rot: AutFx,
    pub tlt: AutFx,
    pub flk: AutFx,
    pub dst: AutFx,
    pub skw: AutFx,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct AutFx {
    pub amt: f32,
    pub audio: bool,
}

/// A beat-locked loop: keyframe lanes keyed by camelCase control id
/// (opacity, scale, sizeX, sizeY, posX, posY, tilt, contrast, hue, sat,
/// brightness, lightAngle).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoopState {
    pub playing: bool,
    pub blocks: f32,
    pub divider: f32,
    pub lanes: HashMap<String, Vec<LanePoint>>,
}

impl Default for LoopState {
    fn default() -> Self {
        Self {
            playing: false,
            blocks: 4.0,
            divider: 1.0,
            lanes: HashMap::new(),
        }
    }
}

/// One automation anchor: phase t (0..1), value v (0..1), and the curvature
/// of the segment LEAVING this point (-1 hard-early .. +1 hard-late).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(default)]
pub struct LanePoint {
    pub t: f32,
    pub v: f32,
    pub bend: f32,
}

impl Default for LanePoint {
    fn default() -> Self {
        Self {
            t: 0.0,
            v: 0.0,
            bend: 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_full_camel_case_payload() {
        let msg: RenderStateMsg = serde_json::from_str(
            r#"{
                "aspect": 1.5, "xfade": 0.25, "cueScene": 1, "bpm": 174,
                "slots": [{
                    "mix": 0.8, "scale": 1.5, "sizeX": 0.6, "sizeY": 0.4,
                    "tilt": 0.1, "contrast": 1.2, "hue": -0.3, "sat": 0.9,
                    "layer": 2, "posX": 0.5, "posY": -0.5,
                    "brightness": 1.5, "lightAngle": 0.7,
                    "band": "high", "amt": 2,
                    "aut": { "rot": { "amt": 1, "audio": true } },
                    "loop": {
                        "playing": true, "blocks": 1, "divider": 4,
                        "lanes": { "opacity": [
                            { "t": 0, "v": 0.5, "bend": 0 },
                            { "t": 1, "v": 0.5, "bend": -1 }
                        ] }
                    }
                }]
            }"#,
        )
        .expect("payload deserializes");
        assert_eq!(msg.cue_scene, 1);
        assert_eq!(msg.bpm, 174.0);
        let s = &msg.slots[0];
        assert_eq!(
            (s.size_x, s.size_y, s.pos_x, s.pos_y),
            (0.6, 0.4, 0.5, -0.5)
        );
        assert_eq!((s.brightness, s.light_angle), (1.5, 0.7));
        assert_eq!((s.band.as_str(), s.amt), ("high", 2.0));
        assert!(s.aut.rot.audio && s.aut.rot.amt == 1.0);
        assert_eq!(s.aut.scl.amt, 0.0); // unmentioned effects default off
        let lp = s.loop_.as_ref().expect("loop present");
        assert!(lp.playing);
        assert_eq!((lp.blocks, lp.divider), (1.0, 4.0));
        assert_eq!(
            lp.lanes["opacity"][1],
            LanePoint {
                t: 1.0,
                v: 0.5,
                bend: -1.0
            }
        );
    }

    #[test]
    fn tolerates_missing_slots_and_fields() {
        let msg: RenderStateMsg = serde_json::from_str(r#"{"aspect": 1.0}"#).unwrap();
        assert!(msg.slots.is_empty());
        assert_eq!(msg.bpm, 120.0);
        assert_eq!(msg.xfade, 0.0);

        // a bare slot object reads as the default deck state
        let msg: RenderStateMsg = serde_json::from_str(r#"{"slots": [{}, {"mix": 1}]}"#).unwrap();
        let d = &msg.slots[0];
        assert_eq!((d.mix, d.scale, d.size_x, d.size_y), (0.0, 1.0, 1.0, 1.0));
        assert_eq!((d.tilt, d.contrast, d.hue, d.sat), (0.0, 1.0, 0.0, 1.0));
        assert_eq!((d.layer, d.brightness), (4.0, 1.0));
        assert_eq!((d.band.as_str(), d.amt), ("level", 1.0));
        assert!(d.loop_.is_none());
        assert_eq!(msg.slots[1].mix, 1.0);
    }

    #[test]
    fn loop_points_default_bend_to_zero() {
        let lp: LoopState =
            serde_json::from_str(r#"{"playing": true, "lanes": {"hue": [{"t": 0.5, "v": 1}]}}"#)
                .unwrap();
        assert_eq!(lp.lanes["hue"][0].bend, 0.0);
        assert_eq!((lp.blocks, lp.divider), (4.0, 1.0)); // defaultLoop()
    }
}
