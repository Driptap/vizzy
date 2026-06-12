// Syphon texture-share output (macOS only): publishes the engine's offscreen
// master target so other VJ software (Resolume, MadMapper, OBS via the Syphon
// plugin) can consume Vizzy's composite as a zero-copy GPU texture.
//
// The vendored Syphon.framework (scripts/fetch-syphon.sh, linked by build.rs)
// has no Rust bindings, so SyphonMetalServer is driven with raw objc2
// messaging; the Metal device/texture handles come from wgpu's Metal hal.
// SyphonOut is intentionally !Send — every call happens on the render thread,
// which creates it, publishes from it, and drops it (drop stops the server).
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use objc2_metal::{MTLCommandBuffer, MTLCommandQueue, MTLDevice};

pub(crate) struct SyphonOut {
    server: Retained<AnyObject>,
    // A dedicated queue for publish work: Metal tracks hazards on the master
    // texture across queues, so committing after wgpu's submit is enough to
    // order the publish blit behind the frame's master pass.
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    warned: bool,
}

impl SyphonOut {
    /// Start a Syphon server named "Vizzy Master" on the wgpu device.
    pub(crate) fn new(device: &wgpu::Device) -> Result<Self, String> {
        let mtl_device = {
            let hal = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }
                .ok_or_else(|| "texture sharing requires the Metal backend".to_string())?;
            hal.raw_device().clone()
        };
        let queue = mtl_device
            .newCommandQueue()
            .ok_or_else(|| "failed to create a Metal command queue for Syphon".to_string())?;
        let name = NSString::from_str("Vizzy Master");
        let server = unsafe {
            let obj: *mut AnyObject = msg_send![class!(SyphonMetalServer), alloc];
            let obj: *mut AnyObject = msg_send![
                obj,
                initWithName: &*name,
                device: &*mtl_device,
                options: std::ptr::null::<AnyObject>()
            ];
            Retained::from_raw(obj)
        }
        .ok_or_else(|| "SyphonMetalServer failed to start".to_string())?;
        Ok(Self {
            server,
            queue,
            warned: false,
        })
    }

    /// Publish one frame. The master target is Bgra8Unorm and rendered
    /// TOP-DOWN upright (vs_present flips the engine's bottom-up convention
    /// at the master pass), which is Syphon's canonical Metal orientation —
    /// so flipped:NO, which also keeps Syphon on its fast blit-copy path.
    pub(crate) fn publish(&mut self, texture: &wgpu::Texture, size: (u32, u32)) {
        let Some(hal) = (unsafe { texture.as_hal::<wgpu::hal::api::Metal>() }) else {
            self.warn_once("master texture is not Metal-backed");
            return;
        };
        let Some(cmd) = self.queue.commandBuffer() else {
            self.warn_once("could not create a Metal command buffer");
            return;
        };
        let region = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(f64::from(size.0), f64::from(size.1)),
        );
        unsafe {
            let _: () = msg_send![
                &*self.server,
                publishFrameTexture: hal.raw_handle(),
                onCommandBuffer: &*cmd,
                imageRegion: region,
                flipped: false
            ];
        }
        cmd.commit();
    }

    fn warn_once(&mut self, what: &str) {
        if !self.warned {
            self.warned = true;
            eprintln!("[vizzy render] syphon publish skipped: {what}");
        }
    }
}

impl Drop for SyphonOut {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![&*self.server, stop];
        }
    }
}
