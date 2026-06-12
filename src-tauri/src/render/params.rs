// Render parameter plumbing: the camelCase IPC payload, per-slot unpacking,
// and the byte-exact uniform packing shared by the render engine and tests.
use serde::Deserialize;

pub const SLOT_COUNT: usize = 8;
/// Floats per slot in `RenderParams::slots`:
/// [mix, scale, sizeX, sizeY, fxTilt, fxContrast, fxHue, fxSat,
///  warpX, warpY, layer, audioLow, audioMid, audioHigh, audioLevel]
pub const SLOT_FLOATS: usize = 15;
/// Compositor uniform: 8 slots x 3 vec4, then globals vec4 + sel vec4.
pub const UNIFORM_FLOATS: usize = SLOT_COUNT * 12 + 8;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderParams {
    pub aspect: f32,
    pub xfade: f32,
    pub cue_scene: u32,
    pub slots: Vec<f32>,
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
        }
    }
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
    }
}
