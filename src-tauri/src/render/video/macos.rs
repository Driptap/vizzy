// macOS video decode via AVFoundation. AVAssetImageGenerator gives random
// access by time (copyCGImageAtTime), which suits reverse / jumps / beat
// behaviours; each CGImage is drawn into an RGBA bitmap context to get tightly
// packed pixels in a guaranteed format, then row-flipped bottom-up like sprites.
use std::ffi::c_void;
use std::path::Path;

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_av_foundation::{AVAssetImageGenerator, AVURLAsset};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGColorSpace, CGContext, CGImage, CGImageAlphaInfo};
use objc2_core_media::CMTime;
use objc2_foundation::{NSString, NSURL};

use super::{DecodedFrame, FrameSource, VideoMeta, MAX_VIDEO_DIM};

// CoreGraphics bitmap-context functions objc2-core-graphics 0.3 doesn't bind.
// Both are long-stable CoreGraphics C entry points (linked via that crate).
#[allow(non_snake_case)]
extern "C" {
    fn CGBitmapContextCreate(
        data: *mut c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        space: *const CGColorSpace,
        bitmap_info: u32,
    ) -> *mut CGContext;
    fn CGContextRelease(c: *mut CGContext);
}

/// 1/600s timebase — fine for second-accurate seeks.
const TIMESCALE: i32 = 600;

pub(crate) struct MacVideo {
    generator: Retained<AVAssetImageGenerator>,
    meta: VideoMeta,
}

impl MacVideo {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let path = path
            .to_str()
            .ok_or_else(|| "video path is not valid UTF-8".to_string())?;
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let asset = AVURLAsset::assetWithURL(&url);
            let duration_s = asset.duration().seconds().max(0.0);

            let generator = AVAssetImageGenerator::initWithAsset(
                AVAssetImageGenerator::alloc(),
                asset.as_ref(),
            );
            generator.setAppliesPreferredTrackTransform(true);
            // Allow the nearest decoded frame within a small window — far faster
            // than forcing exact frames, and fine for VJ playback.
            let tol = CMTime::with_seconds(0.05, TIMESCALE);
            generator.setRequestedTimeToleranceBefore(tol);
            generator.setRequestedTimeToleranceAfter(tol);
            generator.setMaximumSize(CGSize::new(
                f64::from(MAX_VIDEO_DIM),
                f64::from(MAX_VIDEO_DIM),
            ));

            // Decode the first frame once to learn the (capped) dimensions.
            let first = decode(&generator, 0.0)
                .ok_or_else(|| "could not decode the first video frame".to_string())?;
            Ok(Self {
                meta: VideoMeta {
                    width: first.width,
                    height: first.height,
                    duration_s,
                },
                generator,
            })
        }
    }
}

impl FrameSource for MacVideo {
    fn meta(&self) -> VideoMeta {
        self.meta
    }

    fn frame_at(&mut self, t_secs: f64) -> Option<DecodedFrame> {
        unsafe { decode(&self.generator, t_secs) }
    }
}

/// Decode one frame at `t_secs` and convert the CGImage to bottom-up RGBA8.
// copyCGImageAtTime is the synchronous random-access decode; the async variant
// needs a completion block and buys nothing for our render-thread pull model.
#[allow(deprecated)]
unsafe fn decode(generator: &AVAssetImageGenerator, t_secs: f64) -> Option<DecodedFrame> {
    let time = CMTime::with_seconds(t_secs.max(0.0), TIMESCALE);
    let image = generator
        .copyCGImageAtTime_actualTime_error(time, std::ptr::null_mut())
        .ok()?;
    cgimage_to_rgba(&image)
}

/// Draw a CGImage into a fresh RGBA8 bitmap and flip the rows bottom-up.
unsafe fn cgimage_to_rgba(image: &CGImage) -> Option<DecodedFrame> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    if width == 0 || height == 0 {
        return None;
    }
    let color_space = CGColorSpace::new_device_rgb()?;
    let bytes_per_row = width * 4;
    let mut buf = vec![0u8; bytes_per_row * height];

    let ctx = CGBitmapContextCreate(
        buf.as_mut_ptr() as *mut c_void,
        width,
        height,
        8,
        bytes_per_row,
        &*color_space as *const CGColorSpace,
        CGImageAlphaInfo::PremultipliedLast.0,
    );
    if ctx.is_null() {
        return None;
    }
    CGContext::draw_image(
        Some(&*ctx),
        CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(width as f64, height as f64),
        ),
        Some(image),
    );
    CGContextRelease(ctx);

    // CoreGraphics draws top-down; the engine wants v=0 at the image bottom.
    let row = width * 4;
    let mut rgba = Vec::with_capacity(buf.len());
    for y in (0..height).rev() {
        rgba.extend_from_slice(&buf[y * row..(y + 1) * row]);
    }
    Some(DecodedFrame {
        width: width as u32,
        height: height as u32,
        rgba,
    })
}
