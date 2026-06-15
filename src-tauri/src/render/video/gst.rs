// Linux video decode via GStreamer: `filesrc ! decodebin ! videoconvert !
// videoscale ! appsink(RGBA)`. decodebin auto-selects a hardware decoder where
// available (the v4l2 stateful decoder gives Pi 5 HEVC); the appsink caps cap
// the output to MAX_VIDEO_DIM. Frames come out RGBA already; we copy row-by-row
// honouring stride and flip bottom-up to match the engine's convention.
//
// NOTE: this is compiled only on Linux (not on the macOS dev host), so it is
// verified on CI / target devices, written against the gstreamer-rs 0.23 API.
use std::path::Path;
use std::sync::Once;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app::AppSink;
use gstreamer_video as gst_video;
use gstreamer_video::prelude::*;

use super::{DecodedFrame, FrameSource, VideoMeta, MAX_VIDEO_DIM};

static INIT: Once = Once::new();

pub(crate) struct GstVideo {
    pipeline: gst::Pipeline,
    appsink: AppSink,
    meta: VideoMeta,
    /// PTS (seconds) of the last frame we returned — drives the forward fast path.
    last_pts: Option<f64>,
}

impl GstVideo {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        INIT.call_once(|| {
            let _ = gst::init();
        });
        gst::init().map_err(|e| format!("gstreamer init failed: {e}"))?;
        let path = path
            .to_str()
            .ok_or_else(|| "video path is not valid UTF-8".to_string())?;

        let pipeline = gst::Pipeline::new();
        let make = |name: &str| {
            gst::ElementFactory::make(name)
                .build()
                .map_err(|_| format!("gstreamer is missing the '{name}' element"))
        };
        let src = gst::ElementFactory::make("filesrc")
            .property("location", path)
            .build()
            .map_err(|_| "could not create the file source".to_string())?;
        let decode = make("decodebin")?;
        let convert = make("videoconvert")?;
        let scale = make("videoscale")?;
        // RGBA, capped to MAX_VIDEO_DIM on each axis (videoscale fits to the range).
        let caps = gst::Caps::builder("video/x-raw")
            .field("format", "RGBA")
            .field("width", gst::IntRange::new(1, MAX_VIDEO_DIM as i32))
            .field("height", gst::IntRange::new(1, MAX_VIDEO_DIM as i32))
            .build();
        let appsink = gstreamer_app::AppSink::builder()
            .caps(&caps)
            .max_buffers(2)
            .sync(false) // deliver as fast as decoded; the render thread paces
            .build();

        pipeline
            .add_many([&src, &decode, &convert, &scale, appsink.upcast_ref()])
            .map_err(|e| e.to_string())?;
        gst::Element::link_many([&src, &decode]).map_err(|e| e.to_string())?;
        gst::Element::link_many([&convert, &scale, appsink.upcast_ref()])
            .map_err(|e| e.to_string())?;
        // decodebin exposes its decoded pad only after it inspects the stream.
        let convert_weak = convert.downgrade();
        decode.connect_pad_added(move |_, src_pad| {
            if let Some(convert) = convert_weak.upgrade() {
                if let Some(sink_pad) = convert.static_pad("sink") {
                    if !sink_pad.is_linked() {
                        let _ = src_pad.link(&sink_pad);
                    }
                }
            }
        });

        // Preroll to PAUSED so caps negotiate and the first frame is ready.
        pipeline
            .set_state(gst::State::Paused)
            .map_err(|_| "could not start the video pipeline".to_string())?;
        let preroll = appsink
            .pull_preroll()
            .map_err(|_| "could not decode the first video frame".to_string())?;
        let (width, height) =
            sample_dims(&preroll).ok_or_else(|| "video has no readable dimensions".to_string())?;
        let duration_s = pipeline
            .query_duration::<gst::ClockTime>()
            .map(|d| d.nseconds() as f64 / 1e9)
            .unwrap_or(0.0);

        // Stream from here on for the forward fast path.
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|_| "could not play the video pipeline".to_string())?;

        Ok(Self {
            pipeline,
            appsink,
            meta: VideoMeta {
                width,
                height,
                duration_s,
            },
            last_pts: None,
        })
    }
}

impl FrameSource for GstVideo {
    fn meta(&self) -> VideoMeta {
        self.meta
    }

    fn frame_at(&mut self, t_secs: f64) -> Option<DecodedFrame> {
        let t = t_secs.max(0.0);
        // Forward + near → keep streaming; otherwise flush-seek (reverse/jump/loop).
        let need_seek = match self.last_pts {
            Some(last) => t < last - 0.01 || t > last + 0.5,
            None => true,
        };
        if need_seek {
            let pos = gst::ClockTime::from_nseconds((t * 1e9) as u64);
            let _ = self
                .pipeline
                .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, pos);
        }
        // Pull the frame at/after t; on a forward pull, skip frames still behind t.
        loop {
            let sample = self
                .appsink
                .try_pull_sample(gst::ClockTime::from_mseconds(200))?;
            let pts = sample
                .buffer()
                .and_then(|b| b.pts())
                .map(|p| p.nseconds() as f64 / 1e9);
            if let Some(p) = pts {
                self.last_pts = Some(p);
                if !need_seek && p < t - 0.001 {
                    continue; // catch up to the requested time
                }
            }
            return sample_to_frame(&sample);
        }
    }
}

impl Drop for GstVideo {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Width/height from a sample's negotiated caps.
fn sample_dims(sample: &gst::Sample) -> Option<(u32, u32)> {
    let info = gst_video::VideoInfo::from_caps(sample.caps()?).ok()?;
    Some((info.width(), info.height()))
}

/// Copy an RGBA sample into a tightly packed, bottom-up buffer.
fn sample_to_frame(sample: &gst::Sample) -> Option<DecodedFrame> {
    let buffer = sample.buffer()?;
    let info = gst_video::VideoInfo::from_caps(sample.caps()?).ok()?;
    let frame = gst_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info).ok()?;
    let w = frame.width() as usize;
    let h = frame.height() as usize;
    let stride = frame.plane_stride()[0] as usize; // ≥ w*4, may include padding
    let data = frame.plane_data(0).ok()?;
    let row = w * 4;
    let mut rgba = vec![0u8; row * h];
    for y in 0..h {
        let src = &data[y * stride..y * stride + row];
        let dst_y = h - 1 - y; // top-down source → bottom-up texture
        rgba[dst_y * row..dst_y * row + row].copy_from_slice(src);
    }
    Some(DecodedFrame {
        width: w as u32,
        height: h as u32,
        rgba,
    })
}
