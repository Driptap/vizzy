// Evaluated per-frame draw data and the byte-exact uniform packing shared by
// the render engine and tests. Since Phase 4 this is produced natively every
// frame by `evaluate::Evaluator` (the TS client only ships state on change).

pub const SLOT_COUNT: usize = 8;
/// Compositor uniform: 8 slots x 3 vec4, then globals vec4 + sel vec4.
pub const UNIFORM_FLOATS: usize = SLOT_COUNT * 12 + 8;

/// One frame's fully evaluated render input: loop/AUT/audio already applied.
#[derive(Debug, Clone, PartialEq)]
pub struct EvaluatedFrame {
    pub aspect: f32,
    pub xfade: f32,
    pub cue_scene: u32,
    pub slots: [SlotFrame; SLOT_COUNT],
}

impl Default for EvaluatedFrame {
    fn default() -> Self {
        Self {
            aspect: 16.0 / 9.0,
            xfade: 0.0,
            cue_scene: 0,
            slots: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SlotFrame {
    pub uniforms: Slot,
    pub draw: DeckDraw,
}

/// Final per-slot compositor uniform values for one frame.
#[derive(Debug, Clone, Copy, PartialEq)]
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

impl Default for Slot {
    fn default() -> Self {
        Self {
            mix: 0.0,
            scale: 1.0,
            size: [1.0, 1.0],
            fx: [0.0, 1.0, 0.0, 1.0],
            warp: [0.0, 0.0],
            layer: 4.0,
            audio: [0.0; 4],
        }
    }
}

/// What to draw into a deck target this frame. The staged GPU content must
/// match the variant; a mismatch (frame during a swap) draws nothing.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum DeckDraw {
    #[default]
    Shader,
    Sprite(SpriteDraw),
    Model(ModelDraw),
    Flight(FlightDraw),
}

/// Sprite draw: a row-major 2x2 + translation acting on the unit quad, plus
/// the SPRITE_FRAGMENT warp params.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpriteDraw {
    /// [m00, m01, m10, m11]
    pub m: [f32; 4],
    pub t: [f32; 2],
    pub distort: f32,
    pub skew: f32,
    pub opacity: f32,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelDraw {
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
pub struct FlightDraw {
    pub cam: [f32; 3],
    /// (x, y, z, w) — lookAt + SKW roll baked in by the evaluator.
    pub quat: [f32; 4],
    pub tile_z: [f32; 2],
    pub tile_scale_y: f32,
    pub brightness: f32,
    pub light_angle: f32,
    pub visible: bool,
    pub fov_deg: f32,
}

/// Clip position of a unit-square corner (±0.5) under a sprite draw — the
/// exact math vs_sprite runs (y-up; the shader negates y for the bottom-up
/// deck target). Reference implementation for the unit tests.
#[cfg_attr(not(test), allow(dead_code))]
pub fn sprite_clip_pos(s: &SpriteDraw, corner: [f32; 2]) -> [f32; 2] {
    [
        s.m[0] * corner[0] + s.m[1] * corner[1] + s.t[0],
        s.m[2] * corner[0] + s.m[3] * corner[1] + s.t[1],
    ]
}

/// Pack the per-frame compositor uniform, matching `Uniforms` in
/// compositor.wgsl: per slot vec4 a = (mix, scale, layer, 0),
/// vec4 b = (sizeX, sizeY, warpX, warpY), vec4 fx; then
/// globals = (aspect, time, xfade, 0) and sel = (scene, previewSlot, 0, 0).
pub fn pack_compositor_uniform(
    frame: &EvaluatedFrame,
    time: f32,
    scene: u32,
    preview_slot: u32,
) -> [f32; UNIFORM_FLOATS] {
    let mut out = [0.0f32; UNIFORM_FLOATS];
    for (i, slot) in frame.slots.iter().enumerate() {
        let s = &slot.uniforms;
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
    out[g] = frame.aspect;
    out[g + 1] = time;
    out[g + 2] = frame.xfade;
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

    fn distinct_frame() -> EvaluatedFrame {
        // slot i, field j holds 100*i + j so any swap or off-by-one shows up.
        let mut frame = EvaluatedFrame {
            aspect: 1.5,
            xfade: 0.25,
            cue_scene: 1,
            ..Default::default()
        };
        for (i, slot) in frame.slots.iter_mut().enumerate() {
            let v = |j: usize| (100 * i + j) as f32;
            slot.uniforms = Slot {
                mix: v(0),
                scale: v(1),
                size: [v(2), v(3)],
                fx: [v(4), v(5), v(6), v(7)],
                warp: [v(8), v(9)],
                layer: v(10),
                audio: [v(11), v(12), v(13), v(14)],
            };
        }
        frame
    }

    #[test]
    fn default_frame_has_neutral_slots() {
        let f = EvaluatedFrame::default();
        assert_eq!(f.slots.len(), SLOT_COUNT);
        let s = f.slots[7].uniforms;
        assert_eq!(s.mix, 0.0);
        assert_eq!(s.scale, 1.0);
        assert_eq!(s.size, [1.0, 1.0]);
        assert_eq!(s.fx, [0.0, 1.0, 0.0, 1.0]); // tilt 0, contrast 1, hue 0, sat 1
        assert_eq!(s.layer, 4.0);
        assert_eq!(f.slots[3].draw, DeckDraw::Shader);
    }

    #[test]
    fn compositor_uniform_std140_byte_offsets() {
        let frame = distinct_frame();
        let packed = pack_compositor_uniform(&frame, 9.5, 1, 6);
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
    fn sprite_clip_pos_applies_row_major_matrix_and_translation() {
        // Pure translation: corners keep their shape around (tx, ty).
        let s = SpriteDraw {
            m: [1.0, 0.0, 0.0, 1.0],
            t: [0.25, -0.5],
            distort: 0.0,
            skew: 0.0,
            opacity: 1.0,
            visible: true,
        };
        assert_eq!(sprite_clip_pos(&s, [0.5, 0.5]), [0.75, 0.0]);
        assert_eq!(sprite_clip_pos(&s, [-0.5, -0.5]), [-0.25, -1.0]);

        // 90° rotation as the evaluator composes it: m = [c·cos·sx, c·-sin·sy,
        // sin·sx, cos·sy] with c=1, sx=sy=1 → [0, -1, 1, 0].
        let r = SpriteDraw {
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
