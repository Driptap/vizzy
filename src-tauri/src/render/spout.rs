// Spout texture-share output (Windows only): publishes the engine's master
// composite so other VJ software (Resolume, MadMapper, OBS via the Spout
// plugin) can consume Vizzy's output — the Windows sibling of syphon.rs.
//
// This is a native implementation of the Spout 2 sender protocol (no C++ SDK
// linkage): a D3D11 shared texture (D3D11_RESOURCE_MISC_SHARED, the classic
// non-NT handle every 2.006/2.007 receiver understands) plus the shared-memory
// sender registry — the "SpoutSenderNames" name list, the "ActiveSenderName"
// map, and a per-sender 280-byte SharedTextureInfo map, each guarded by a
// "<name>_mutex" named mutex, exactly as SpoutSharedMemory does.
//
// First cut publishes via CPU readback (wgpu master target -> staging buffer
// -> UpdateSubresource on the shared texture). ~8 MB/frame at 1080p60 —
// measurable but dependable; the zero-copy upgrade is D3D11on12 wrapping of
// wgpu's DX12 resource, which can come once this path is field-proven.
use windows::core::{Interface, PCSTR};
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HMODULE, INVALID_HANDLE_VALUE, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_RESOURCE_MISC_SHARED, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIResource;
use windows::Win32::System::Memory::{
    CreateFileMappingA, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS, PAGE_READWRITE,
};
use windows::Win32::System::Threading::{CreateMutexA, ReleaseMutex, WaitForSingleObject};

/// SpoutMaxSenderNameLen — fixed 256-byte name slots everywhere.
const NAME_LEN: usize = 256;
/// Default registry capacity (Spout 2.007 m_MaxSenders).
const MAX_SENDERS: usize = 64;
/// sizeof(SharedTextureInfo): 5 u32 fields + 256-byte description + u32.
const INFO_LEN: usize = 280;

/// One named shared-memory map with its companion "<name>_mutex", following
/// SpoutSharedMemory semantics (created or opened, lock waits 67 ms).
struct SharedMap {
    mapping: HANDLE,
    view: *mut u8,
    mutex: HANDLE,
    size: usize,
}

impl SharedMap {
    fn create(name: &str, size: usize) -> Result<Self, String> {
        let cname = nul_terminated(name);
        let cmutex = nul_terminated(&format!("{name}_mutex"));
        unsafe {
            let mapping = CreateFileMappingA(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                size as u32,
                PCSTR(cname.as_ptr()),
            )
            .map_err(|e| format!("CreateFileMapping({name}) failed: {e}"))?;
            let view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, size);
            if view.Value.is_null() {
                let _ = CloseHandle(mapping);
                return Err(format!("MapViewOfFile({name}) failed"));
            }
            // A missing mutex degrades to unguarded access, like Spout does.
            let mutex = CreateMutexA(None, false, PCSTR(cmutex.as_ptr())).unwrap_or_default();
            Ok(Self {
                mapping,
                view: view.Value.cast(),
                mutex,
                size,
            })
        }
    }

    /// Run `f` over the mapped bytes under the named mutex (67 ms wait, the
    /// SpoutSharedMemory timeout). Proceeds unguarded on timeout — readers
    /// tolerate a torn frame of registry data; a stuck registry must not
    /// stall the render thread.
    fn with_lock<R>(&self, f: impl FnOnce(&mut [u8]) -> R) -> R {
        unsafe {
            let locked = !self.mutex.is_invalid() && {
                let wait = WaitForSingleObject(self.mutex, 67);
                wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED
            };
            let bytes = std::slice::from_raw_parts_mut(self.view, self.size);
            let result = f(bytes);
            if locked {
                let _ = ReleaseMutex(self.mutex);
            }
            result
        }
    }
}

impl Drop for SharedMap {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(windows::Win32::System::Memory::MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.view.cast(),
            });
            let _ = CloseHandle(self.mapping);
            if !self.mutex.is_invalid() {
                let _ = CloseHandle(self.mutex);
            }
        }
    }
}

fn nul_terminated(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    v
}

/// Copy `name` into a fixed 256-byte slot, NUL-padded (strcpy_s semantics).
fn write_name_slot(slot: &mut [u8], name: &str) {
    slot.fill(0);
    let bytes = name.as_bytes();
    let len = bytes.len().min(NAME_LEN - 1);
    slot[..len].copy_from_slice(&bytes[..len]);
}

fn slot_matches(slot: &[u8], name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() < NAME_LEN && slot[..bytes.len()] == *bytes && slot.get(bytes.len()) == Some(&0)
}

pub(crate) struct SpoutOut {
    name: String,
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    texture: ID3D11Texture2D,
    share_handle: HANDLE,
    size: (u32, u32),
    /// Held open for our lifetime: Windows file mappings vanish when the last
    /// handle closes, so the registry only exists while a sender keeps it.
    names: SharedMap,
    active: SharedMap,
    info: SharedMap,
    warned: bool,
}

impl SpoutOut {
    /// Start a Spout sender publishing the master composite.
    pub(crate) fn new(name: &str, width: u32, height: u32) -> Result<Self, String> {
        let (device, context) = create_d3d11_device()?;
        let (texture, share_handle) = create_shared_texture(&device, width, height)?;

        let names = SharedMap::create("SpoutSenderNames", MAX_SENDERS * NAME_LEN)?;
        let active = SharedMap::create("ActiveSenderName", NAME_LEN)?;
        let info = SharedMap::create(name, INFO_LEN)?;

        let registered = names.with_lock(|bytes| {
            // already present (a previous unclean exit) reuses the slot
            for slot in bytes.chunks_exact_mut(NAME_LEN) {
                if slot_matches(slot, name) {
                    return true;
                }
            }
            for slot in bytes.chunks_exact_mut(NAME_LEN) {
                if slot[0] == 0 {
                    write_name_slot(slot, name);
                    return true;
                }
            }
            false
        });
        if !registered {
            return Err("Spout sender registry is full".to_string());
        }
        active.with_lock(|bytes| write_name_slot(bytes, name));

        let out = Self {
            name: name.to_string(),
            _device: device,
            context,
            texture,
            share_handle,
            size: (width, height),
            names,
            active,
            info,
            warned: false,
        };
        out.write_info();
        Ok(out)
    }

    /// SharedTextureInfo, little-endian, exactly as receivers read it. The
    /// 64-bit share handle is truncated to 32 bits (HandleToLong) — shared
    /// texture handles fit by construction.
    fn write_info(&self) {
        let (w, h) = self.size;
        let handle32 = self.share_handle.0 as usize as u32;
        self.info.with_lock(|bytes| {
            bytes.fill(0);
            bytes[0..4].copy_from_slice(&handle32.to_le_bytes());
            bytes[4..8].copy_from_slice(&w.to_le_bytes());
            bytes[8..12].copy_from_slice(&h.to_le_bytes());
            bytes[12..16].copy_from_slice(&(DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32).to_le_bytes());
            bytes[16..20].copy_from_slice(&(D3D11_USAGE_DEFAULT.0 as u32).to_le_bytes());
            let desc = b"Vizzy";
            bytes[20..20 + desc.len()].copy_from_slice(desc);
            // partnerId (last 4 bytes) stays 0
        });
    }

    /// Publish one frame of tightly-packed BGRA rows (top-down — the master
    /// target's storage order, which is also D3D's).
    pub(crate) fn publish(&mut self, pixels: &[u8], width: u32, height: u32) {
        if pixels.len() != (width as usize) * (height as usize) * 4 {
            self.warn_once("pixel buffer does not match its dimensions");
            return;
        }
        if (width, height) != self.size {
            match create_shared_texture(&self._device, width, height) {
                Ok((texture, handle)) => {
                    self.texture = texture;
                    self.share_handle = handle;
                    self.size = (width, height);
                    self.write_info(); // receivers detect resize via the info map
                }
                Err(e) => {
                    self.warn_once(&format!("could not resize the shared texture: {e}"));
                    return;
                }
            }
        }
        unsafe {
            self.context.UpdateSubresource(
                &self.texture,
                0,
                None,
                pixels.as_ptr().cast(),
                width * 4,
                0,
            );
            self.context.Flush();
        }
    }

    fn warn_once(&mut self, what: &str) {
        if !self.warned {
            self.warned = true;
            eprintln!("[vizzy render] spout publish skipped: {what}");
        }
    }
}

impl Drop for SpoutOut {
    fn drop(&mut self) {
        // ReleaseSenderName semantics: clear our registry slot and the active
        // sender if it is us; the info map dies with its handle below.
        self.names.with_lock(|bytes| {
            for slot in bytes.chunks_exact_mut(NAME_LEN) {
                if slot_matches(slot, &self.name) {
                    slot.fill(0);
                }
            }
        });
        self.active.with_lock(|bytes| {
            if slot_matches(bytes, &self.name) {
                bytes.fill(0);
            }
        });
    }
}

fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
    }
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context)),
        _ => Err("D3D11CreateDevice returned no device".to_string()),
    }
}

/// The classic Spout shared texture: BGRA8, default usage, MISC_SHARED
/// (legacy handle — what 2.006 and 2.007 receivers both open).
fn create_shared_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, HANDLE), String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width.max(1),
        Height: height.max(1),
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: D3D11_RESOURCE_MISC_SHARED.0 as u32,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|e| format!("CreateTexture2D (shared) failed: {e}"))?;
    }
    let texture = texture.ok_or_else(|| "CreateTexture2D returned no texture".to_string())?;
    let resource: IDXGIResource = texture
        .cast()
        .map_err(|e| format!("shared texture has no IDXGIResource: {e}"))?;
    let handle = unsafe {
        resource
            .GetSharedHandle()
            .map_err(|e| format!("GetSharedHandle failed: {e}"))?
    };
    Ok((texture, handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_slots_match_and_pad() {
        let mut slot = [0xffu8; NAME_LEN];
        write_name_slot(&mut slot, "Vizzy Master");
        assert!(slot_matches(&slot, "Vizzy Master"));
        assert!(!slot_matches(&slot, "Vizzy"));
        assert_eq!(slot[12], 0);
        assert_eq!(slot[NAME_LEN - 1], 0);
    }

    #[test]
    fn info_layout_is_280_bytes() {
        assert_eq!(INFO_LEN, 4 + 4 + 4 + 4 + 4 + 256 + 4);
    }
}
