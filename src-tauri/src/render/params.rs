// Render parameter plumbing: the camelCase IPC payload, per-slot unpacking,
// and the byte-exact uniform packing shared by the render engine and tests.
use serde::Deserialize;

pub const SLOT_COUNT: usize = 8;
/// Floats per slot in `RenderParams::slots`:
/// [mix, scale, sizeX, sizeY, fxTilt, fxContrast, fxHue, fxSat,
///  warpX, warpY, layer, audioLow, audioMid, audioHigh, audioLevel]
pub const SLOT_FLOATS: usize = 15;
/// Floats per slot in `RenderParams::decks`: the non-shader deck ext block.
/// ext[0] is the mode (0 shader, 1 sprite, 2 model, 3 flight); the rest is
/// mode-specific (see `unpack_deck_ext`).
pub const DECK_EXT_FLOATS: usize = 16;
/// Compositor uniform: 8 slots x 3 vec4, then globals vec4 + sel vec4.
pub const UNIFORM_FLOATS: usize = SLOT_COUNT * 12 + 8;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderParams {
    pub aspect: f32,
    pub xfade: f32,
    pub cue_scene: u32,
    pub slots: Vec<f32>,
    /// Per-deck ext blocks (8 x 16); missing or short ⇒ all decks mode 0.
    #[serde(default)]
    pub decks: Vec<f32>,
}

impl Default for RenderParams {
    fn default() -> Self {
        let mut slots = vec![0.0; SLOT_COUNT * SLOT_FLOATS];
        for i in 0..SLOT_COUNT {
            let s = &mut slots[i * SLOT_FLOATS..(i + 1) * SLOT_FLOATS];
            s[1] = 1.0; // scale
            s[2] = 1.0; // sizeX
            s[3] = 1.0; // sizeY
            s[5] = 1.0; // contrast
            s[7] = 1.0; // saturation
            s[10] = 4.0; // layer (base)
        }
        Self {
            aspect: 16.0 / 9.0,
            xfade: 0.0,
            cue_scene: 0,
            slots,
            decks: vec![0.0; SLOT_COUNT * DECK_EXT_FLOATS],
        }
    }
}

/// Sprite ext: a row-major 2x2 + translation acting on the unit quad, plus
/// the SPRITE_FRAGMENT warp params.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpriteExt {
    /// [m00, m01, m10, m11]
    pub m: [f32; 4],
    pub t: [f32; 2],
    pub distort: f32,
    pub skew: f32,
    pub opacity: f32,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelExt {
    pub pos: [f32; 3],
    /// (x, y, z, w)
    pub quat: [f32; 4],
    /// Per-axis: the jelly distortion squashes each axis independently.
    pub scale: [f32; 3],
    pub brightness: f32,
    pub light_angle: f32,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlightExt {
    pub cam: [f32; 3],
    /// (x, y, z, w) — the TS side bakes lookAt+roll into this.
    pub quat: [f32; 4],
    pub tile_z: [f32; 2],
    pub tile_scale_y: f32,
    pub brightness: f32,
    pub light_angle: f32,
    pub visible: bool,
    pub fov_deg: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DeckExt {
    Shader,
    Sprite(SpriteExt),
    Model(ModelExt),
    Flight(FlightExt),
}

/// Decode one deck's ext block. Missing/short vectors and unknown modes read
/// as Shader so a stale client payload can never panic the render loop.
pub fn unpack_deck_ext(decks: &[f32], index: usize) -> DeckExt {
    let at = |i: usize| {
        decks
            .get(index * DECK_EXT_FLOATS + i)
            .copied()
            .unwrap_or(0.0)
    };
    match at(0).round() as i32 {
        1 => DeckExt::Sprite(SpriteExt {
            m: [at(1), at(2), at(3), at(4)],
            t: [at(5), at(6)],
            distort: at(7),
            skew: at(8),
            opacity: at(9),
            visible: at(10) >= 0.5,
        }),
        2 => DeckExt::Model(ModelExt {
            pos: [at(1), at(2), at(3)],
            quat: [at(4), at(5), at(6), at(7)],
            scale: [at(8), at(12), at(13)],
            brightness: at(9),
            light_angle: at(10),
            visible: at(11) >= 0.5,
        }),
        3 => DeckExt::Flight(FlightExt {
            cam: [at(1), at(2), at(3)],
            quat: [at(4), at(5), at(6), at(7)],
            tile_z: [at(8), at(9)],
            tile_scale_y: at(10),
            brightness: at(11),
            light_angle: at(12),
            visible: at(13) >= 0.5,
            fov_deg: at(14),
        }),
        _ => DeckExt::Shader,
    }
}

/// Clip position of a unit-square corner (±0.5) under a sprite ext — the
/// exact math vs_sprite runs (y-up; the shader negates y for the bottom-up
/// deck target). Reference implementation for the unit tests.
#[cfg_attr(not(test), allow(dead_code))]
pub fn sprite_clip_pos(s: &SpriteExt, corner: [f32; 2]) -> [f32; 2] {
    [
        s.m[0] * corner[0] + s.m[1] * corner[1] + s.t[0],
        s.m[2] * corner[0] + s.m[3] * corner[1] + s.t[1],
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Slot {
    pub mix: f32,
    pub scale: f32,
    pub size: [f32; 2],
    /// tilt (radians), contrast, hue rotation (radians), saturation
    pub fx: [f32; 4],
    pub warp: [f32; 2],
    pub layer: f32,
    /// low, mid, high, level — final per-deck uniform values
    pub audio: [f32; 4],
}

/// Unpack one slot from the flat 8x15 float array; missing values read as 0
/// so a short or empty vector never panics the render loop.
pub fn unpack_slot(slots: &[f32], index: usize) -> Slot {
    let at = |i: usize| slots.get(index * SLOT_FLOATS + i).copied().unwrap_or(0.0);
    Slot {
        mix: at(0),
        scale: at(1),
        size: [at(2), at(3)],
        fx: [at(4), at(5), at(6), at(7)],
        warp: [at(8), at(9)],
        layer: at(10),
        audio: [at(11), at(12), at(13), at(14)],
    }
}

/// Pack the per-frame compositor uniform, matching `Uniforms` in
/// compositor.wgsl: per slot vec4 a = (mix, scale, layer, 0),
/// vec4 b = (sizeX, sizeY, warpX, warpY), vec4 fx; then
/// globals = (aspect, time, xfade, 0) and sel = (scene, previewSlot, 0, 0).
pub fn pack_compositor_uniform(
    params: &RenderParams,
    time: f32,
    scene: u32,
    preview_slot: u32,
) -> [f32; UNIFORM_FLOATS] {
    let mut out = [0.0f32; UNIFORM_FLOATS];
    for i in 0..SLOT_COUNT {
        let s = unpack_slot(&params.slots, i);
        let o = i * 12;
        out[o] = s.mix;
        out[o + 1] = s.scale;
        out[o + 2] = s.layer;
        out[o + 4] = s.size[0];
        out[o + 5] = s.size[1];
        out[o + 6] = s.warp[0];
        out[o + 7] = s.warp[1];
        out[o + 8..o + 12].copy_from_slice(&s.fx);
    }
    let g = SLOT_COUNT * 12;
    out[g] = params.aspect;
    out[g + 1] = time;
    out[g + 2] = params.xfade;
    out[g + 4] = scene as f32;
    out[g + 5] = preview_slot as f32;
    out
}

/// Per-deck uniform matching ingest::DECK_HEADER's std140 block:
/// vec2 u_resolution @0, u_time @8, audio low/mid/high/level @12..28,
/// padded to 32 bytes.
pub fn pack_deck_uniform(width: f32, height: f32, time: f32, audio: [f32; 4]) -> [f32; 8] {
    [
        width, height, time, audio[0], audio[1], audio[2], audio[3], 0.0,
    ]
}

pub fn floats_to_bytes(data: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 4);
    for v in data {
        out.extend_from_slice(&v.to_ne_bytes());
    }
    out
}

/// Strip the 256-byte row padding from a readback and flip vertically:
/// offscreen targets are stored bottom-up (vUv origin at the bottom-left),
/// JPEG rows run top-down.
pub fn unpad_and_flip_rows(data: &[u8], width: usize, height: usize, padded_row: usize) -> Vec<u8> {
    let row = width * 4;
    let mut out = Vec::with_capacity(row * height);
    for y in (0..height).rev() {
        let start = y * padded_row;
        out.extend_from_slice(&data[start..start + row]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn distinct_params() -> RenderParams {
        // slot i, field j holds 100*i + j so any swap or off-by-one shows up.
        let mut slots = vec![0.0; SLOT_COUNT * SLOT_FLOATS];
        for (i, v) in slots.iter_mut().enumerate() {
            *v = (i / SLOT_FLOATS * 100 + i % SLOT_FLOATS) as f32;
        }
        RenderParams {
            aspect: 1.5,
            xfade: 0.25,
            cue_scene: 1,
            slots,
            decks: vec![],
        }
    }

    #[test]
    fn unpack_slot_reads_contract_order() {
        let p = distinct_params();
        let s = unpack_slot(&p.slots, 3);
        assert_eq!(s.mix, 300.0);
        assert_eq!(s.scale, 301.0);
        assert_eq!(s.size, [302.0, 303.0]);
        assert_eq!(s.fx, [304.0, 305.0, 306.0, 307.0]);
        assert_eq!(s.warp, [308.0, 309.0]);
        assert_eq!(s.layer, 310.0);
        assert_eq!(s.audio, [311.0, 312.0, 313.0, 314.0]);
    }

    #[test]
    fn unpack_slot_tolerates_short_vectors() {
        let s = unpack_slot(&[], 7);
        assert_eq!(s, Slot::default());
    }

    #[test]
    fn compositor_uniform_std140_byte_offsets() {
        let p = distinct_params();
        let packed = pack_compositor_uniform(&p, 9.5, 1, 6);
        let bytes = floats_to_bytes(&packed);
        assert_eq!(bytes.len(), 416);

        let f = |offset: usize| f32::from_ne_bytes(bytes[offset..offset + 4].try_into().unwrap());
        // Slot 5: a = (mix, scale, layer, 0) @ 5*48, b @ +16, fx @ +32.
        let base = 5 * 48;
        assert_eq!(f(base), 500.0); // mix
        assert_eq!(f(base + 4), 501.0); // scale
        assert_eq!(f(base + 8), 510.0); // layer
        assert_eq!(f(base + 12), 0.0); // pad
        assert_eq!(f(base + 16), 502.0); // sizeX
        assert_eq!(f(base + 20), 503.0); // sizeY
        assert_eq!(f(base + 24), 508.0); // warpX
        assert_eq!(f(base + 28), 509.0); // warpY
        assert_eq!(f(base + 32), 504.0); // fx tilt
        assert_eq!(f(base + 36), 505.0); // fx contrast
        assert_eq!(f(base + 40), 506.0); // fx hue
        assert_eq!(f(base + 44), 507.0); // fx sat
                                         // Globals @ 384, sel @ 400.
        assert_eq!(f(384), 1.5); // aspect
        assert_eq!(f(388), 9.5); // time
        assert_eq!(f(392), 0.25); // xfade
        assert_eq!(f(400), 1.0); // scene select
        assert_eq!(f(404), 6.0); // preview slot
    }

    #[test]
    fn deck_uniform_matches_header_layout() {
        let bytes = floats_to_bytes(&pack_deck_uniform(960.0, 540.0, 2.0, [0.1, 0.2, 0.3, 0.4]));
        assert_eq!(bytes.len(), 32);
        let f = |offset: usize| f32::from_ne_bytes(bytes[offset..offset + 4].try_into().unwrap());
        assert_eq!(f(0), 960.0); // u_resolution.x
        assert_eq!(f(4), 540.0); // u_resolution.y
        assert_eq!(f(8), 2.0); // u_time
        assert_eq!(f(12), 0.1); // u_audio_low
        assert_eq!(f(16), 0.2); // u_audio_mid
        assert_eq!(f(20), 0.3); // u_audio_high
        assert_eq!(f(24), 0.4); // u_audio_level
    }

    #[test]
    fn unpad_and_flip_reverses_rows_and_strips_padding() {
        // 2x3 image with 256-byte padded rows; pixel value = row index.
        let (w, h, padded) = (2usize, 3usize, 256usize);
        let mut data = vec![0xEEu8; padded * h];
        for y in 0..h {
            for b in 0..w * 4 {
                data[y * padded + b] = y as u8;
            }
        }
        let out = unpad_and_flip_rows(&data, w, h, padded);
        assert_eq!(out.len(), w * 4 * h);
        assert!(out[..8].iter().all(|&b| b == 2));
        assert!(out[8..16].iter().all(|&b| b == 1));
        assert!(out[16..].iter().all(|&b| b == 0));
    }

    #[test]
    fn render_params_deserializes_camel_case() {
        let p: RenderParams =
            serde_json::from_str(r#"{"aspect":1.0,"xfade":0.5,"cueScene":1,"slots":[1,2,3]}"#)
                .expect("camelCase payload should deserialize");
        assert_eq!(p.cue_scene, 1);
        assert_eq!(p.slots, vec![1.0, 2.0, 3.0]);
        // Old clients omit decks entirely — everything reads as mode 0.
        assert!(p.decks.is_empty());
        assert_eq!(unpack_deck_ext(&p.decks, 3), DeckExt::Shader);

        let p: RenderParams = serde_json::from_str(
            r#"{"aspect":1.0,"xfade":0.5,"cueScene":1,"slots":[],"decks":[1,2,3]}"#,
        )
        .expect("decks payload should deserialize");
        assert_eq!(p.decks, vec![1.0, 2.0, 3.0]);
    }

    fn ext_block(slot: usize, values: &[f32]) -> Vec<f32> {
        let mut decks = vec![0.0; SLOT_COUNT * DECK_EXT_FLOATS];
        decks[slot * DECK_EXT_FLOATS..slot * DECK_EXT_FLOATS + values.len()]
            .copy_from_slice(values);
        decks
    }

    #[test]
    fn deck_ext_decodes_sprite_mode() {
        let decks = ext_block(
            2,
            &[1.0, 0.9, -0.1, 0.1, 0.8, 0.25, -0.5, 0.3, 0.2, 0.7, 1.0],
        );
        let ext = unpack_deck_ext(&decks, 2);
        assert_eq!(
            ext,
            DeckExt::Sprite(SpriteExt {
                m: [0.9, -0.1, 0.1, 0.8],
                t: [0.25, -0.5],
                distort: 0.3,
                skew: 0.2,
                opacity: 0.7,
                visible: true,
            })
        );
        // every other slot stays a shader deck
        assert_eq!(unpack_deck_ext(&decks, 0), DeckExt::Shader);
    }

    #[test]
    fn deck_ext_decodes_model_mode_with_per_axis_scale() {
        let decks = ext_block(
            0,
            &[
                2.0, 0.1, 0.2, 0.3, 0.0, 0.6, 0.0, 0.8, 1.1, 1.5, 0.4, 1.0, 1.2, 1.3,
            ],
        );
        let ext = unpack_deck_ext(&decks, 0);
        assert_eq!(
            ext,
            DeckExt::Model(ModelExt {
                pos: [0.1, 0.2, 0.3],
                quat: [0.0, 0.6, 0.0, 0.8],
                scale: [1.1, 1.2, 1.3], // sclX @8, sclY @12, sclZ @13
                brightness: 1.5,
                light_angle: 0.4,
                visible: true,
            })
        );
    }

    #[test]
    fn deck_ext_decodes_flight_mode() {
        let decks = ext_block(
            7,
            &[
                3.0, 0.5, 2.0, 4.0, 0.0, 0.0, 0.0, 1.0, -3.0, -12.0, 1.2, 0.9, -0.3, 0.0, 64.0,
            ],
        );
        let ext = unpack_deck_ext(&decks, 7);
        assert_eq!(
            ext,
            DeckExt::Flight(FlightExt {
                cam: [0.5, 2.0, 4.0],
                quat: [0.0, 0.0, 0.0, 1.0],
                tile_z: [-3.0, -12.0],
                tile_scale_y: 1.2,
                brightness: 0.9,
                light_angle: -0.3,
                visible: false,
                fov_deg: 64.0,
            })
        );
    }

    #[test]
    fn deck_ext_tolerates_garbage_modes_and_short_vectors() {
        assert_eq!(unpack_deck_ext(&[], 5), DeckExt::Shader);
        assert_eq!(unpack_deck_ext(&[9.0], 0), DeckExt::Shader);
        assert_eq!(unpack_deck_ext(&[f32::NAN], 0), DeckExt::Shader);
        // mode float at the start of a TRUNCATED block: remaining fields are 0
        assert_eq!(
            unpack_deck_ext(&[1.0], 0),
            DeckExt::Sprite(SpriteExt {
                m: [0.0; 4],
                t: [0.0; 2],
                distort: 0.0,
                skew: 0.0,
                opacity: 0.0,
                visible: false,
            })
        );
    }

    #[test]
    fn sprite_clip_pos_applies_row_major_matrix_and_translation() {
        // Pure translation: corners keep their shape around (tx, ty).
        let s = SpriteExt {
            m: [1.0, 0.0, 0.0, 1.0],
            t: [0.25, -0.5],
            distort: 0.0,
            skew: 0.0,
            opacity: 1.0,
            visible: true,
        };
        assert_eq!(sprite_clip_pos(&s, [0.5, 0.5]), [0.75, 0.0]);
        assert_eq!(sprite_clip_pos(&s, [-0.5, -0.5]), [-0.25, -1.0]);

        // 90° rotation as the TS client composes it: m = [c·cos·sx, c·-sin·sy,
        // sin·sx, cos·sy] with c=1, sx=sy=1 → [0, -1, 1, 0].
        let r = SpriteExt {
            m: [0.0, -1.0, 1.0, 0.0],
            t: [0.0, 0.0],
            distort: 0.0,
            skew: 0.0,
            opacity: 1.0,
            visible: true,
        };
        // The right edge midpoint rotates up to the top.
        let p = sprite_clip_pos(&r, [0.5, 0.0]);
        assert!((p[0] - 0.0).abs() < 1e-6 && (p[1] - 0.5).abs() < 1e-6);
    }
}
