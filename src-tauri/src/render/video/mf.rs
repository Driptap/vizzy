// Windows video decode via Media Foundation (IMFSourceReader). MF ships with
// Windows, so there's no extra runtime for users (the `windows` crate is already
// a dependency for Spout). The reader is configured with video processing on and
// an RGB32 output (BGRA in memory), scaled to MAX_VIDEO_DIM; we swap to RGBA and
// flip rows bottom-up to match the engine's convention.
//
// NOTE: compiled only on Windows (not on the macOS dev host), so it is verified
// on CI / target devices, written against the `windows` 0.61 API. COM + MF are
// started on the decode thread and the reader is used only there (single-thread).
use std::path::Path;
use std::ptr;

use windows::core::HSTRING;
use windows::Win32::Media::MediaFoundation::{
    IMFSample, IMFSourceReader, MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromURL,
    MFMediaType_Video, MFShutdown, MFStartup, MFVideoFormat_RGB32, MFSTARTUP_FULL,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_PD_DURATION,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READER_MEDIASOURCE, MF_VERSION,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VT_I8;

use super::{DecodedFrame, FrameSource, VideoMeta, MAX_VIDEO_DIM};

const FIRST_VIDEO_STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
const MEDIASOURCE: u32 = MF_SOURCE_READER_MEDIASOURCE.0 as u32;

pub(crate) struct MfVideo {
    reader: IMFSourceReader,
    meta: VideoMeta,
    /// Timestamp (seconds) of the last frame returned — drives the forward fast path.
    last_ts: Option<f64>,
}

impl MfVideo {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let path = path
            .to_str()
            .ok_or_else(|| "video path is not valid UTF-8".to_string())?;
        unsafe {
            // COM + MF on this (decode) thread; torn down in Drop.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| format!("MFStartup failed: {e}"))?;

            // Let the reader decode + colour-convert + scale to our output type.
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 1).map_err(|e| e.to_string())?;
            let attrs = attrs.ok_or_else(|| "could not create MF attributes".to_string())?;
            attrs
                .SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)
                .map_err(|e| e.to_string())?;

            let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path), &attrs)
                .map_err(|e| format!("could not open the video: {e}"))?;

            // Native size → scaled target (≤ MAX_VIDEO_DIM, aspect preserved).
            let native = reader
                .GetNativeMediaType(FIRST_VIDEO_STREAM, 0)
                .map_err(|e| e.to_string())?;
            let packed = native
                .GetUINT64(&MF_MT_FRAME_SIZE)
                .map_err(|e| e.to_string())?;
            let (nw, nh) = ((packed >> 32) as u32, (packed & 0xffff_ffff) as u32);
            let (width, height) = scaled_size(nw.max(1), nh.max(1));

            // Request RGB32 output at the scaled size.
            let out = MFCreateMediaType().map_err(|e| e.to_string())?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(|e| e.to_string())?;
            out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
                .map_err(|e| e.to_string())?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64)
                .map_err(|e| e.to_string())?;
            reader
                .SetCurrentMediaType(FIRST_VIDEO_STREAM, None, &out)
                .map_err(|e| format!("RGB32 output not supported: {e}"))?;

            // Duration (100-ns units) from the media source.
            let duration_s = reader
                .GetPresentationAttribute(MEDIASOURCE, &MF_PD_DURATION)
                .ok()
                .map(|pv| propvariant_u64(&pv) as f64 / 1e7)
                .unwrap_or(0.0);

            Ok(Self {
                reader,
                meta: VideoMeta {
                    width,
                    height,
                    duration_s,
                },
                last_ts: None,
            })
        }
    }
}

impl FrameSource for MfVideo {
    fn meta(&self) -> VideoMeta {
        self.meta
    }

    fn frame_at(&mut self, t_secs: f64) -> Option<DecodedFrame> {
        let t = t_secs.max(0.0);
        // Forward + near → keep streaming; otherwise seek (reverse/jump/loop).
        let need_seek = match self.last_ts {
            Some(last) => t < last - 0.01 || t > last + 0.5,
            None => true,
        };
        unsafe {
            if need_seek {
                let pos = propvariant_i8((t * 1e7) as i64); // 100-ns units
                let _ = self
                    .reader
                    .SetCurrentPosition(&windows::core::GUID::zeroed(), &pos);
            }
            // Pull samples until at/after t (skip frames still behind on a forward pull).
            for _ in 0..64 {
                let mut flags: u32 = 0;
                let mut ts: i64 = 0;
                let mut sample: Option<IMFSample> = None;
                if self
                    .reader
                    .ReadSample(
                        FIRST_VIDEO_STREAM,
                        0,
                        None,
                        Some(&mut flags),
                        Some(&mut ts),
                        Some(&mut sample),
                    )
                    .is_err()
                {
                    return None;
                }
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    return None; // engine loops by seeking back to ~0
                }
                let Some(sample) = sample else {
                    continue; // a stream tick without data (e.g. format change)
                };
                let secs = ts as f64 / 1e7;
                self.last_ts = Some(secs);
                if !need_seek && secs < t - 0.001 {
                    continue; // catch up to the requested time
                }
                return sample_to_frame(&sample, self.meta.width, self.meta.height);
            }
            None
        }
    }
}

impl Drop for MfVideo {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

/// Cap the longest side to MAX_VIDEO_DIM, preserving aspect (even dimensions).
fn scaled_size(w: u32, h: u32) -> (u32, u32) {
    let longest = w.max(h);
    if longest <= MAX_VIDEO_DIM {
        return (w, h);
    }
    let s = MAX_VIDEO_DIM as f64 / longest as f64;
    (
        ((w as f64 * s) as u32 & !1).max(2),
        ((h as f64 * s) as u32 & !1).max(2),
    )
}

/// Copy an RGB32 (BGRA) sample into a tightly packed, bottom-up RGBA buffer.
unsafe fn sample_to_frame(sample: &IMFSample, width: u32, height: u32) -> Option<DecodedFrame> {
    let buffer = sample.ConvertToContiguousBuffer().ok()?;
    let mut ptr: *mut u8 = ptr::null_mut();
    let mut len: u32 = 0;
    buffer.Lock(&mut ptr, None, Some(&mut len)).ok()?;
    let row = (width as usize) * 4;
    let h = height as usize;
    let mut rgba = vec![0u8; row * h];
    if !ptr.is_null() && len as usize >= row * h {
        let src = std::slice::from_raw_parts(ptr, row * h);
        for y in 0..h {
            let s = &src[y * row..y * row + row];
            let dst_y = h - 1 - y; // MF rows are top-down → bottom-up texture
            let d = &mut rgba[dst_y * row..dst_y * row + row];
            for x in 0..width as usize {
                d[x * 4] = s[x * 4 + 2]; // R <- B
                d[x * 4 + 1] = s[x * 4 + 1]; // G
                d[x * 4 + 2] = s[x * 4]; // B <- R
                d[x * 4 + 3] = s[x * 4 + 3]; // A
            }
        }
    }
    let _ = buffer.Unlock();
    Some(DecodedFrame {
        width,
        height,
        rgba,
    })
}

/// Build a VT_I8 PROPVARIANT (for SetCurrentPosition, 100-ns units).
unsafe fn propvariant_i8(value: i64) -> PROPVARIANT {
    let mut pv: PROPVARIANT = std::mem::zeroed();
    pv.Anonymous.Anonymous.vt = VT_I8;
    pv.Anonymous.Anonymous.Anonymous.hVal = value;
    pv
}

/// Read the unsigned 64-bit value out of a PROPVARIANT (MF_PD_DURATION).
unsafe fn propvariant_u64(pv: &PROPVARIANT) -> u64 {
    pv.Anonymous.Anonymous.Anonymous.uhVal
}
