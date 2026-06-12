// Non-shader deck content: CPU-side decode/parse for sprites (images) and
// meshes (3D model files / raw scene buffers), the geometry normalization the
// THREE engine performed at stage time (baked into the vertices here so the
// client's unit transforms render at the same size), and the light-rig math
// ported from RenderEngine.buildLightRig / automation.applyLightRig.
use std::path::Path;

use super::math3d::{self, Mat4};
use super::params::{FlightDraw, ModelDraw};

/// THREE's LANDSCAPE_WIDTH: imported landscape meshes get their widest
/// horizontal axis scaled to this.
pub const LANDSCAPE_WIDTH: f32 = 9.0;
/// Neutral material colour for OBJ/STL (0xd8d8e8, like modelLoader.ts) —
/// sRGB-encoded, like every three.js hex colour; linearized at stage time.
pub const NEUTRAL_COLOR: [f32; 3] = [
    0xd8 as f32 / 255.0,
    0xd8 as f32 / 255.0,
    0xe8 as f32 / 255.0,
];
/// OBJ/STL material constants from the old modelLoader.ts, now honored.
pub const NEUTRAL_ROUGHNESS: f32 = 0.45;
pub const NEUTRAL_METALLIC: f32 = 0.25;
const CYAN_RIM: [f32; 3] = [
    0x22 as f32 / 255.0,
    0xd3 as f32 / 255.0,
    0xee as f32 / 255.0,
];
const MAGENTA_KEY: [f32; 3] = [
    0xe8 as f32 / 255.0,
    0x79 as f32 / 255.0,
    0xf9 as f32 / 255.0,
];
const WHITE: [f32; 3] = [1.0, 1.0, 1.0];

/// Floats in the per-draw mesh uniform (see MeshUniforms in content.wgsl).
pub const MESH_UNIFORM_FLOATS: usize = 72;
/// Floats in the per-primitive material uniform (PrimUniforms in content.wgsl):
/// base-colour factor rgba + (metallic, shininess, 0, 0).
pub const PRIM_UNIFORM_FLOATS: usize = 8;

// ------------------------------------------------------------ colour space

/// sRGB electro-optical transfer function (decode), the exact piecewise curve
/// three.js applies to hex colours and texture inputs — not a pow(2.2) approx.
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Inverse sRGB transfer function (encode). The mesh shader applies the same
/// curve on output (encode_srgb in content.wgsl); this CPU twin is the test
/// reference implementation.
#[cfg_attr(not(test), allow(dead_code))]
pub fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

pub fn srgb_to_linear3(c: [f32; 3]) -> [f32; 3] {
    [
        srgb_to_linear(c[0]),
        srgb_to_linear(c[1]),
        srgb_to_linear(c[2]),
    ]
}

/// Blinn-Phong shininess from glTF roughness: 2/roughness⁴, clamped so
/// roughness 1 still leaves a wide lobe and roughness→0 stays finite.
pub fn shininess_from_roughness(roughness: f32) -> f32 {
    let r = roughness.clamp(0.0, 1.0);
    (2.0 / (r * r * r * r).max(1e-4)).clamp(2.0, 1024.0)
}

// ---------------------------------------------------------------- sprites

/// Decode an image file (png/jpeg/webp/gif — first frame) to RGBA8 with the
/// rows flipped bottom-up, so texture v=0 is the BOTTOM of the upright image
/// (matching vUv convention everywhere else in the engine).
pub fn load_sprite_rgba(path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    let reader = image::ImageReader::open(path)
        .map_err(|e| format!("failed to open image: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("failed to read image: {e}"))?;
    let img = reader
        .decode()
        .map_err(|e| format!("failed to decode image: {e}"))?;
    let rgba = img.to_rgba8();
    let (width, height) = (rgba.width(), rgba.height());
    let data = rgba.into_raw();
    let row = width as usize * 4;
    let mut flipped = Vec::with_capacity(data.len());
    for y in (0..height as usize).rev() {
        flipped.extend_from_slice(&data[y * row..(y + 1) * row]);
    }
    Ok((flipped, width, height))
}

// ----------------------------------------------------------------- meshes

/// Texture wrap mode, kept wgpu-free so content stays a pure CPU module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TexWrap {
    #[default]
    Repeat,
    Clamp,
    Mirror,
}

/// A decoded base-colour texture ready for sRGB upload + CPU mip generation.
#[derive(Debug, Clone)]
pub struct MeshTexture {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub wrap_u: TexWrap,
    pub wrap_v: TexWrap,
}

/// One draw range of the merged mesh with its material: glTF primitives map
/// 1:1; OBJ/STL and procedural scenes are a single whole-mesh primitive.
/// `base_color` is LINEAR (glTF factors are linear per spec); `texture`
/// indexes `MeshData::textures`.
#[derive(Debug, Clone, PartialEq)]
pub struct MeshPrimitive {
    pub start: u32,
    pub count: u32,
    pub base_color: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    pub texture: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct MeshData {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    /// LINEAR vertex colours (sRGB sources are decoded at load/stage time).
    pub colors: Vec<[f32; 3]>,
    /// glTF TEXCOORD_0; (0,0) when absent so the white fallback samples flat.
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
    pub primitives: Vec<MeshPrimitive>,
    pub textures: Vec<MeshTexture>,
}

impl MeshData {
    /// Append one primitive's geometry and record its index range + material.
    #[allow(clippy::too_many_arguments)]
    fn append_primitive(
        &mut self,
        positions: Vec<[f32; 3]>,
        normals: Vec<[f32; 3]>,
        colors: Vec<[f32; 3]>,
        uvs: Vec<[f32; 2]>,
        indices: Vec<u32>,
        base_color: [f32; 4],
        metallic: f32,
        roughness: f32,
        texture: Option<usize>,
    ) {
        let base = self.positions.len() as u32;
        let start = self.indices.len() as u32;
        self.positions.extend(positions);
        self.normals.extend(normals);
        self.colors.extend(colors);
        self.uvs.extend(uvs);
        self.indices.extend(indices.into_iter().map(|i| i + base));
        self.primitives.push(MeshPrimitive {
            start,
            count: self.indices.len() as u32 - start,
            base_color,
            metallic,
            roughness,
            texture,
        });
    }
}

/// Area-weighted smooth vertex normals — Lambert-style lighting needs them.
pub fn compute_normals(positions: &[[f32; 3]], indices: &[u32]) -> Vec<[f32; 3]> {
    let mut acc = vec![[0.0f32; 3]; positions.len()];
    for tri in indices.chunks_exact(3) {
        let (a, b, c) = (
            positions[tri[0] as usize],
            positions[tri[1] as usize],
            positions[tri[2] as usize],
        );
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        for &i in tri {
            let dst = &mut acc[i as usize];
            dst[0] += n[0];
            dst[1] += n[1];
            dst[2] += n[2];
        }
    }
    acc.into_iter().map(math3d::normalize3).collect()
}

/// Load a model file as one merged, lit-ready mesh. Formats follow
/// modelLoader.ts minus .fbx (no maintained pure-Rust loader).
pub fn load_mesh(path: &Path) -> Result<MeshData, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mesh = match ext.as_str() {
        "glb" | "gltf" => load_gltf(path)?,
        "obj" => load_obj(path)?,
        "stl" => load_stl(path)?,
        other => {
            return Err(format!(
                "Unsupported model type: .{} (native engine supports .glb/.gltf/.obj/.stl)",
                if other.is_empty() { "unknown" } else { other }
            ))
        }
    };
    if mesh.indices.len() < 3 || mesh.positions.is_empty() {
        return Err("model contains no triangle geometry".into());
    }
    Ok(mesh)
}

fn load_gltf(path: &Path) -> Result<MeshData, String> {
    let (doc, buffers, images) =
        gltf::import(path).map_err(|e| format!("glTF load failed: {e}"))?;
    let mut out = MeshData::default();
    // glTF texture index → MeshData::textures index, decoded once.
    let mut texture_cache: Vec<Option<Option<usize>>> = vec![None; doc.textures().count()];
    let scene = doc
        .default_scene()
        .or_else(|| doc.scenes().next())
        .ok_or_else(|| "glTF has no scenes".to_string())?;
    for node in scene.nodes() {
        push_gltf_node(
            &node,
            &math3d::IDENTITY,
            &buffers,
            &images,
            &mut texture_cache,
            &mut out,
        );
    }
    Ok(out)
}

fn gltf_wrap(mode: gltf::texture::WrappingMode) -> TexWrap {
    match mode {
        gltf::texture::WrappingMode::ClampToEdge => TexWrap::Clamp,
        gltf::texture::WrappingMode::MirroredRepeat => TexWrap::Mirror,
        gltf::texture::WrappingMode::Repeat => TexWrap::Repeat,
    }
}

/// Expand a decoded glTF image to tightly packed RGBA8. 8/16-bit channel
/// layouts are converted; float formats are skipped (factor-only fallback).
pub fn gltf_image_to_rgba(img: &gltf::image::Data) -> Option<(Vec<u8>, u32, u32)> {
    use gltf::image::Format as F;
    let texels = (img.width as usize).checked_mul(img.height as usize)?;
    if texels == 0 {
        return None;
    }
    let chan = |n: usize| -> Option<Vec<u8>> {
        // 8-bit source: spread n channels into RGBA (missing g/b copy r? no —
        // glTF base colour is RGB(A); R8/R8G8 pad with 0 and alpha 255).
        if img.pixels.len() != texels * n {
            return None;
        }
        let mut out = Vec::with_capacity(texels * 4);
        for px in img.pixels.chunks_exact(n) {
            out.push(px[0]);
            out.push(if n > 1 { px[1] } else { px[0] });
            out.push(if n > 2 { px[2] } else { px[0] });
            out.push(if n > 3 { px[3] } else { 255 });
        }
        Some(out)
    };
    let chan16 = |n: usize| -> Option<Vec<u8>> {
        if img.pixels.len() != texels * n * 2 {
            return None;
        }
        let mut out = Vec::with_capacity(texels * 4);
        for px in img.pixels.chunks_exact(n * 2) {
            let at = |i: usize| u16::from_le_bytes([px[i * 2], px[i * 2 + 1]]);
            let v = |i: usize| (at(i) >> 8) as u8;
            out.push(v(0));
            out.push(if n > 1 { v(1) } else { v(0) });
            out.push(if n > 2 { v(2) } else { v(0) });
            out.push(if n > 3 { v(3) } else { 255 });
        }
        Some(out)
    };
    let rgba = match img.format {
        F::R8 => chan(1)?,
        F::R8G8 => chan(2)?,
        F::R8G8B8 => chan(3)?,
        F::R8G8B8A8 => chan(4)?,
        F::R16 => chan16(1)?,
        F::R16G16 => chan16(2)?,
        F::R16G16B16 => chan16(3)?,
        F::R16G16B16A16 => chan16(4)?,
        F::R32G32B32FLOAT | F::R32G32B32A32FLOAT => return None,
    };
    Some((rgba, img.width, img.height))
}

/// Decode (or fetch from cache) the MeshData texture for a glTF texture.
fn gltf_texture(
    tex: &gltf::Texture,
    images: &[gltf::image::Data],
    cache: &mut [Option<Option<usize>>],
    out: &mut MeshData,
) -> Option<usize> {
    let slot = cache.get_mut(tex.index())?;
    if let Some(cached) = slot {
        return *cached;
    }
    let decoded = images
        .get(tex.source().index())
        .and_then(gltf_image_to_rgba)
        .map(|(rgba, width, height)| {
            out.textures.push(MeshTexture {
                rgba,
                width,
                height,
                wrap_u: gltf_wrap(tex.sampler().wrap_s()),
                wrap_v: gltf_wrap(tex.sampler().wrap_t()),
            });
            out.textures.len() - 1
        });
    *slot = Some(decoded);
    decoded
}

fn push_gltf_node(
    node: &gltf::Node,
    parent: &Mat4,
    buffers: &[gltf::buffer::Data],
    images: &[gltf::image::Data],
    texture_cache: &mut [Option<Option<usize>>],
    out: &mut MeshData,
) {
    let local: Mat4 = {
        let cols = node.transform().matrix(); // [[f32; 4]; 4] column-major
        let mut m = [0.0; 16];
        for (c, col) in cols.iter().enumerate() {
            m[c * 4..c * 4 + 4].copy_from_slice(col);
        }
        m
    };
    let world = math3d::mat4_mul(parent, &local);
    if let Some(mesh) = node.mesh() {
        let normal_mat = math3d::inverse_transpose3(&world);
        for prim in mesh.primitives() {
            if prim.mode() != gltf::mesh::Mode::Triangles {
                continue;
            }
            let reader = prim.reader(|b| buffers.get(b.index()).map(|d| &d.0[..]));
            let Some(positions) = reader.read_positions() else {
                continue;
            };
            let positions: Vec<[f32; 3]> = positions
                .map(|p| math3d::transform_point(&world, p))
                .collect();
            let indices: Vec<u32> = match reader.read_indices() {
                Some(read) => read.into_u32().collect(),
                None => (0..positions.len() as u32).collect(),
            };
            let normals: Vec<[f32; 3]> = match reader.read_normals() {
                Some(read) => read
                    .map(|n| math3d::normalize3(math3d::mul3(&normal_mat, n)))
                    .collect(),
                None => compute_normals(&positions, &indices),
            };
            // COLOR_0 is linear per the glTF spec; the (linear) baseColorFactor
            // ships separately in the primitive uniform, like THREE.
            let colors: Vec<[f32; 3]> = match reader.read_colors(0) {
                Some(read) => read.into_rgb_f32().collect(),
                None => vec![WHITE; positions.len()],
            };
            let material = prim.material();
            let pbr = material.pbr_metallic_roughness();
            let base = pbr.base_color_factor();
            // The default material (no material assigned) renders neutral
            // dielectric; assigned materials keep their spec-default factors.
            let (metallic, roughness) = if material.index().is_none() {
                (0.0, 1.0)
            } else {
                (pbr.metallic_factor(), pbr.roughness_factor())
            };
            // Base-colour texture: TEXCOORD_0 only (the engine carries one UV
            // set); hardware sRGB decode happens at upload.
            let texture = pbr
                .base_color_texture()
                .filter(|info| info.tex_coord() == 0)
                .and_then(|info| gltf_texture(&info.texture(), images, texture_cache, out));
            let uvs: Vec<[f32; 2]> = match reader.read_tex_coords(0) {
                Some(read) => read.into_f32().collect(),
                None => vec![[0.0, 0.0]; positions.len()],
            };
            if normals.len() == positions.len()
                && colors.len() == positions.len()
                && uvs.len() == positions.len()
            {
                out.append_primitive(
                    positions, normals, colors, uvs, indices, base, metallic, roughness, texture,
                );
            }
        }
    }
    for child in node.children() {
        push_gltf_node(&child, &world, buffers, images, texture_cache, out);
    }
}

/// The OBJ/STL neutral material: linearized 0xd8d8e8 base colour with the old
/// modelLoader roughness/metalness, as one whole-mesh primitive.
fn neutral_primitive(count: u32) -> MeshPrimitive {
    let n = srgb_to_linear3(NEUTRAL_COLOR);
    MeshPrimitive {
        start: 0,
        count,
        base_color: [n[0], n[1], n[2], 1.0],
        metallic: NEUTRAL_METALLIC,
        roughness: NEUTRAL_ROUGHNESS,
        texture: None,
    }
}

fn load_obj(path: &Path) -> Result<MeshData, String> {
    let (models, _materials) = tobj::load_obj(
        path,
        &tobj::LoadOptions {
            triangulate: true,
            single_index: true,
            ..Default::default()
        },
    )
    .map_err(|e| format!("OBJ load failed: {e}"))?;
    let mut out = MeshData::default();
    for model in models {
        let m = model.mesh;
        let positions: Vec<[f32; 3]> = m
            .positions
            .chunks_exact(3)
            .map(|p| [p[0], p[1], p[2]])
            .collect();
        let indices: Vec<u32> = m
            .indices
            .iter()
            .map(|&i| i + out.positions.len() as u32)
            .collect();
        let normals: Vec<[f32; 3]> = if m.normals.len() == m.positions.len() {
            m.normals
                .chunks_exact(3)
                .map(|n| [n[0], n[1], n[2]])
                .collect()
        } else {
            compute_normals(&positions, &m.indices)
        };
        out.colors.extend(vec![WHITE; positions.len()]);
        out.uvs.extend(vec![[0.0, 0.0]; positions.len()]);
        out.positions.extend(positions);
        out.normals.extend(normals);
        out.indices.extend(indices);
    }
    out.primitives = vec![neutral_primitive(out.indices.len() as u32)];
    Ok(out)
}

fn load_stl(path: &Path) -> Result<MeshData, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("failed to open STL: {e}"))?;
    let stl = stl_io::read_stl(&mut file).map_err(|e| format!("STL load failed: {e}"))?;
    let positions: Vec<[f32; 3]> = stl.vertices.iter().map(|v| [v[0], v[1], v[2]]).collect();
    let indices: Vec<u32> = stl
        .faces
        .iter()
        .flat_map(|f| f.vertices.iter().map(|&i| i as u32))
        .collect();
    let normals = compute_normals(&positions, &indices);
    let colors = vec![WHITE; positions.len()];
    let uvs = vec![[0.0, 0.0]; positions.len()];
    let primitives = vec![neutral_primitive(indices.len() as u32)];
    Ok(MeshData {
        positions,
        normals,
        colors,
        uvs,
        indices,
        primitives,
        textures: Vec::new(),
    })
}

/// Vertex-coloured mesh from the raw buffers `render_stage_scene` receives.
/// Palette colours arrive sRGB-encoded from the TS generator (hex palette);
/// they are linearized here so lighting happens in linear like THREE did.
pub fn scene_mesh(positions: &[f32], colors: &[f32], indices: &[u32]) -> Result<MeshData, String> {
    let positions: Vec<[f32; 3]> = positions
        .chunks_exact(3)
        .map(|p| [p[0], p[1], p[2]])
        .collect();
    if positions.is_empty() {
        return Err("scene mesh has no vertices".into());
    }
    let mut cols: Vec<[f32; 3]> = colors
        .chunks_exact(3)
        .map(|c| srgb_to_linear3([c[0], c[1], c[2]]))
        .collect();
    cols.resize(positions.len(), [1.0, 1.0, 1.0]);
    cols.truncate(positions.len());
    let indices: Vec<u32> = if indices.is_empty() {
        (0..positions.len() as u32).collect()
    } else {
        indices.to_vec()
    };
    if indices.len() < 3 {
        return Err("scene mesh has no triangles".into());
    }
    if indices.iter().any(|&i| i as usize >= positions.len()) {
        return Err("scene mesh index out of range".into());
    }
    let normals = compute_normals(&positions, &indices);
    let uvs = vec![[0.0, 0.0]; positions.len()];
    // Procedural tiles stay matte — their look IS the vertex-colour palette.
    let primitives = vec![MeshPrimitive {
        start: 0,
        count: indices.len() as u32,
        base_color: [1.0, 1.0, 1.0, 1.0],
        metallic: 0.0,
        roughness: 1.0,
        texture: None,
    }];
    Ok(MeshData {
        positions,
        normals,
        colors: cols,
        uvs,
        indices,
        primitives,
        textures: Vec::new(),
    })
}

/// Interleave to the vertex layout vs_mesh consumes:
/// pos(3) normal(3) color(3) uv(2).
pub fn interleave(mesh: &MeshData) -> Vec<f32> {
    let mut out = Vec::with_capacity(mesh.positions.len() * 11);
    for i in 0..mesh.positions.len() {
        out.extend_from_slice(&mesh.positions[i]);
        out.extend_from_slice(&mesh.normals[i]);
        out.extend_from_slice(&mesh.colors[i]);
        out.extend_from_slice(mesh.uvs.get(i).unwrap_or(&[0.0, 0.0]));
    }
    out
}

// ------------------------------------------------------------- mip chain

/// Number of mip levels for a full chain down to 1×1.
pub fn mip_level_count(width: u32, height: u32) -> u32 {
    32 - width.max(height).max(1).leading_zeros()
}

/// One box-filtered mip step (odd dimensions clamp the 2×2 footprint). Box
/// filtering sRGB bytes directly is the classic cheap chain — load-time only.
pub fn next_mip(rgba: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let (w, h) = (width.max(1) as usize, height.max(1) as usize);
    let (ow, oh) = ((w / 2).max(1), (h / 2).max(1));
    let mut out = Vec::with_capacity(ow * oh * 4);
    for oy in 0..oh {
        for ox in 0..ow {
            let (x0, y0) = (ox * 2, oy * 2);
            let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
            for c in 0..4 {
                let sum = u32::from(rgba[(y0 * w + x0) * 4 + c])
                    + u32::from(rgba[(y0 * w + x1) * 4 + c])
                    + u32::from(rgba[(y1 * w + x0) * 4 + c])
                    + u32::from(rgba[(y1 * w + x1) * 4 + c]);
                out.push(((sum + 2) / 4) as u8);
            }
        }
    }
    (out, ow as u32, oh as u32)
}

// --------------------------------------------- normalization / tile layout

struct Bbox {
    min: [f32; 3],
    max: [f32; 3],
}

fn bbox(positions: &[[f32; 3]]) -> Bbox {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in positions {
        for a in 0..3 {
            min[a] = min[a].min(p[a]);
            max[a] = max[a].max(p[a]);
        }
    }
    if positions.is_empty() {
        return Bbox {
            min: [0.0; 3],
            max: [0.0; 3],
        };
    }
    Bbox { min, max }
}

/// Bake stageModel's normalization into the geometry: centre on the bbox
/// centre and scale to 2.2/maxDim, so the client's unit transforms (baseScale
/// = 1 on the TS side) render at the same size THREE did.
pub fn bake_model_normalization(mesh: &mut MeshData) {
    let b = bbox(&mesh.positions);
    let center = [
        (b.min[0] + b.max[0]) * 0.5,
        (b.min[1] + b.max[1]) * 0.5,
        (b.min[2] + b.max[2]) * 0.5,
    ];
    let size = [
        b.max[0] - b.min[0],
        b.max[1] - b.min[1],
        b.max[2] - b.min[2],
    ];
    let max_dim = size[0].max(size[1]).max(size[2]).max(1e-6);
    let scale = 2.2 / max_dim;
    for p in &mut mesh.positions {
        for a in 0..3 {
            p[a] = (p[a] - center[a]) * scale;
        }
    }
}

/// Staged tile state for the endless-flight modes: `base_scale` (s) and the
/// z-mirror are NOT in the per-frame ext block — the TS client animates the
/// tiles around unit scale, so s and the mirror must live here, baked into
/// each frame's tile matrices.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileLayout {
    pub base_scale: f32,
    pub span: f32,
    pub height: f32,
}

/// Bake stageTiledFlight's object offset into the vertices and return the
/// tile dimensions. The offset sits INSIDE the tile group in THREE (scale
/// applies to it), so baking it pre-scale is exact.
pub fn bake_tile_layout(mesh: &mut MeshData, normalize: bool, ground: bool) -> TileLayout {
    let b = bbox(&mesh.positions);
    let size = [
        b.max[0] - b.min[0],
        b.max[1] - b.min[1],
        b.max[2] - b.min[2],
    ];
    let center = [
        (b.min[0] + b.max[0]) * 0.5,
        (b.min[1] + b.max[1]) * 0.5,
        (b.min[2] + b.max[2]) * 0.5,
    ];
    let widest = size[0].max(size[2]).max(1e-6);
    let base_scale = if normalize {
        LANDSCAPE_WIDTH / widest
    } else {
        1.0
    };
    let offset = [
        -center[0],
        if ground { -b.min[1] } else { -center[1] },
        -center[2],
    ];
    for p in &mut mesh.positions {
        for a in 0..3 {
            p[a] += offset[a];
        }
    }
    TileLayout {
        base_scale,
        span: (size[2] * base_scale).max(1.0),
        height: (size[1] * base_scale).max(0.01),
    }
}

/// (span, camHeight) returned to the client as LandscapeMeta.
pub fn landscape_meta(layout: &TileLayout, fly_through: bool) -> (f32, f32) {
    let cam_height = if fly_through {
        0.0
    } else {
        layout.height * 0.55 + 0.5
    };
    (layout.span, cam_height)
}

// ------------------------------------------------------------- light rigs

/// A buildLightRig configuration: white ambient + key + fixed cyan rim.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rig {
    pub ambient: f32,
    pub key_color: [f32; 3],
    pub key_intensity: f32,
    pub key_pos: [f32; 3],
    pub rim_intensity: f32,
    pub rim_pos: [f32; 3],
}

/// Model decks: neutral key so imported colours read true.
pub const MODEL_RIG: Rig = Rig {
    ambient: 0.5,
    key_color: WHITE,
    key_intensity: 1.6,
    key_pos: [2.0, 3.0, 4.0],
    rim_intensity: 1.2,
    rim_pos: [-3.0, -1.0, -2.0],
};

/// Landscapes: magenta horizon sun.
pub const LANDSCAPE_RIG: Rig = Rig {
    ambient: 0.45,
    key_color: MAGENTA_KEY,
    key_intensity: 1.4,
    key_pos: [0.0, 2.0, -6.0],
    rim_intensity: 0.9,
    rim_pos: [3.0, 4.0, 2.0],
};

/// Procedural scenes: ambient-heavy with a neutral key — palette stays true.
pub const SCENE_RIG: Rig = Rig {
    ambient: 0.8,
    key_color: WHITE,
    key_intensity: 0.8,
    key_pos: [0.0, 2.0, -6.0],
    rim_intensity: 0.45,
    rim_pos: [3.0, 4.0, 2.0],
};

/// Frame-resolved lighting (applyLightRig): brightness scales the whole rig,
/// light_angle orbits the key about +y; the rim stays put. Directions point
/// TOWARD the light (THREE directional lights target the origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RigLight {
    pub ambient: [f32; 3],
    pub key_dir: [f32; 3],
    pub key_color: [f32; 3],
    pub rim_dir: [f32; 3],
    pub rim_color: [f32; 3],
}

pub fn rig_light(rig: &Rig, brightness: f32, light_angle: f32) -> RigLight {
    // buildLightRig: keyRadius = hypot(x, z) || 1 (the `|| 1` only fires at 0)
    let radius = match rig.key_pos[0].hypot(rig.key_pos[2]) {
        r if r > 0.0 => r,
        _ => 1.0,
    };
    let angle = rig.key_pos[0].atan2(rig.key_pos[2]) + light_angle;
    let key_pos = [radius * angle.sin(), rig.key_pos[1], radius * angle.cos()];
    let scale = |c: [f32; 3], i: f32| [c[0] * i, c[1] * i, c[2] * i];
    // Rig colours are three.js sRGB hex values; three linearized them
    // internally, so decode before intensity scaling (lighting is linear).
    RigLight {
        ambient: scale(WHITE, rig.ambient * brightness),
        key_dir: math3d::normalize3(key_pos),
        key_color: scale(
            srgb_to_linear3(rig.key_color),
            rig.key_intensity * brightness,
        ),
        rim_dir: math3d::normalize3(rig.rim_pos),
        rim_color: scale(srgb_to_linear3(CYAN_RIM), rig.rim_intensity * brightness),
    }
}

/// Rotate the rig's world-space light directions into view space — fs_mesh
/// lights in view space (normals via the model-view normal matrix, view
/// vector from the view-space position), exactly like THREE's shaders.
fn light_to_view(light: &RigLight, view: &Mat4) -> RigLight {
    let r = [
        [view[0], view[1], view[2]],
        [view[4], view[5], view[6]],
        [view[8], view[9], view[10]],
    ];
    RigLight {
        key_dir: math3d::mul3(&r, light.key_dir),
        rim_dir: math3d::mul3(&r, light.rim_dir),
        ..*light
    }
}

// ----------------------------------------------------- per-draw uniforms

fn pack_mesh_uniform(
    mvp: &Mat4,
    model_view: &Mat4,
    normal: &[[f32; 3]; 3],
    light: &RigLight,
    fog: Option<([f32; 3], f32, f32)>,
) -> [f32; MESH_UNIFORM_FLOATS] {
    let mut out = [0.0; MESH_UNIFORM_FLOATS];
    out[0..16].copy_from_slice(mvp);
    out[16..32].copy_from_slice(model_view);
    for c in 0..3 {
        out[32 + c * 4..32 + c * 4 + 3].copy_from_slice(&normal[c]);
    }
    out[44..47].copy_from_slice(&light.ambient);
    out[48..51].copy_from_slice(&light.key_dir);
    out[52..55].copy_from_slice(&light.key_color);
    out[56..59].copy_from_slice(&light.rim_dir);
    out[60..63].copy_from_slice(&light.rim_color);
    if let Some((color, near, far)) = fog {
        out[64..67].copy_from_slice(&color);
        out[67] = 1.0; // fog enable
        out[68] = near;
        out[69] = far;
    }
    out
}

/// Per-frame uniform for a model deck: fixed camera (45° fov, eye (0,0,4) →
/// origin), model matrix T·R·S from the ext block, model rig, no fog.
pub fn pack_model_uniform(ext: &ModelDraw, aspect: f32) -> [f32; MESH_UNIFORM_FLOATS] {
    let proj = math3d::perspective(45f32.to_radians(), aspect, 0.1, 100.0);
    let view: Mat4 = {
        let mut v = math3d::IDENTITY;
        v[14] = -4.0;
        v
    };
    let model = math3d::compose_trs(ext.pos, ext.quat, ext.scale);
    let model_view = math3d::mat4_mul(&view, &model);
    let mvp = math3d::mat4_mul(&proj, &model_view);
    // View-space normal matrix (the camera rotation is identity here, so this
    // equals the old world-space matrix — but it keeps fs_mesh's one frame).
    let normal = math3d::inverse_transpose3(&model_view);
    let light = light_to_view(
        &rig_light(&MODEL_RIG, ext.brightness, ext.light_angle),
        &view,
    );
    pack_mesh_uniform(&mvp, &model_view, &normal, &light, None)
}

/// Per-frame uniform for one flight tile. `base_scale`/`span`/rig/fog are
/// staged state; the ext block carries the camera and the tile z/y-scale.
/// Tile 1 is the z-mirrored copy (negative z scale, seam-to-seam).
pub fn pack_flight_uniform(
    ext: &FlightDraw,
    tile: usize,
    base_scale: f32,
    span: f32,
    rig: &Rig,
    fog_color: [f32; 3],
    aspect: f32,
) -> [f32; MESH_UNIFORM_FLOATS] {
    let fov = ext.fov_deg.clamp(1.0, 179.0).to_radians();
    let proj = math3d::perspective(fov, aspect, 0.05, span * 2.5);
    let view = math3d::view_from_camera(ext.cam, ext.quat);
    let s = base_scale;
    let scale = [s, ext.tile_scale_y, if tile == 0 { s } else { -s }];
    let model = math3d::compose_trs(
        [0.0, 0.0, ext.tile_z[tile.min(1)]],
        [0.0, 0.0, 0.0, 1.0],
        scale,
    );
    let model_view = math3d::mat4_mul(&view, &model);
    let mvp = math3d::mat4_mul(&proj, &model_view);
    let normal = math3d::inverse_transpose3(&model_view);
    let light = light_to_view(&rig_light(rig, ext.brightness, ext.light_angle), &view);
    pack_mesh_uniform(
        &mvp,
        &model_view,
        &normal,
        &light,
        Some((fog_color, span * 0.3, span * 1.9)),
    )
}

/// Pack one primitive's material uniform (PrimUniforms in content.wgsl):
/// linear base-colour factor, metallic, and the Blinn-Phong shininess derived
/// from roughness on the CPU so the shader stays branch-free.
pub fn pack_prim_uniform(prim: &MeshPrimitive) -> [f32; PRIM_UNIFORM_FLOATS] {
    [
        prim.base_color[0],
        prim.base_color[1],
        prim.base_color[2],
        prim.base_color[3],
        prim.metallic.clamp(0.0, 1.0),
        shininess_from_roughness(prim.roughness),
        0.0,
        0.0,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    fn quad_mesh(min: [f32; 3], max: [f32; 3]) -> MeshData {
        // two points define the bbox; pad with the corners to make triangles
        let positions = vec![min, [max[0], min[1], min[2]], [min[0], max[1], max[2]], max];
        let indices = vec![0, 1, 2, 1, 3, 2];
        let normals = compute_normals(&positions, &indices);
        let colors = vec![[1.0, 1.0, 1.0]; 4];
        let uvs = vec![[0.0, 0.0]; 4];
        let primitives = vec![MeshPrimitive {
            start: 0,
            count: 6,
            base_color: [1.0; 4],
            metallic: 0.0,
            roughness: 1.0,
            texture: None,
        }];
        MeshData {
            positions,
            normals,
            colors,
            uvs,
            indices,
            primitives,
            textures: Vec::new(),
        }
    }

    #[test]
    fn srgb_transfer_round_trips_reference_values() {
        // The canonical mid-grey: 0.5 linear encodes to ~0.7354.
        assert!((linear_to_srgb(0.5) - 0.735_357).abs() < 1e-4);
        assert!((srgb_to_linear(0.735_357) - 0.5).abs() < 1e-4);
        // Linear-segment boundary values and endpoints.
        assert!(close(linear_to_srgb(0.0), 0.0) && close(linear_to_srgb(1.0), 1.0));
        assert!(close(srgb_to_linear(0.0), 0.0) && close(srgb_to_linear(1.0), 1.0));
        assert!((srgb_to_linear(0.04045) - 0.04045 / 12.92).abs() < 1e-6);
        // Round trip across the range.
        for i in 0..=20 {
            let v = i as f32 / 20.0;
            assert!((srgb_to_linear(linear_to_srgb(v)) - v).abs() < 1e-5);
        }
        // Encoding brightens every mid-tone — the whole point of B1.
        for v in [0.1, 0.18, 0.5, 0.9] {
            assert!(linear_to_srgb(v) > v);
        }
    }

    #[test]
    fn mip_chain_dimensions_walk_down_to_one() {
        assert_eq!(mip_level_count(1, 1), 1);
        assert_eq!(mip_level_count(2, 2), 2);
        assert_eq!(mip_level_count(960, 540), 10);
        assert_eq!(mip_level_count(5, 3), 3); // 5x3 -> 2x1 -> 1x1
        let rgba = vec![100u8; 5 * 3 * 4];
        let (l1, w1, h1) = next_mip(&rgba, 5, 3);
        assert_eq!((w1, h1), (2, 1));
        assert_eq!(l1.len(), 2 * 4);
        let (l2, w2, h2) = next_mip(&l1, w1, h1);
        assert_eq!((w2, h2), (1, 1));
        assert_eq!(l2.len(), 4);
        // box filter averages: a 2x2 checker of 0/200 mips to ~100
        let checker = [
            200u8, 200, 200, 255, 0, 0, 0, 255, 0, 0, 0, 255, 200, 200, 200, 255,
        ];
        let (avg, _, _) = next_mip(&checker, 2, 2);
        assert_eq!(avg[0], 100);
        assert_eq!(avg[3], 255);
    }

    #[test]
    fn shininess_is_monotonic_in_roughness_and_clamped() {
        let samples = [0.0, 0.1, 0.25, 0.45, 0.6, 0.8, 1.0];
        for pair in samples.windows(2) {
            assert!(
                shininess_from_roughness(pair[0]) >= shininess_from_roughness(pair[1]),
                "shininess must not increase with roughness ({} vs {})",
                pair[0],
                pair[1]
            );
        }
        assert!(close(shininess_from_roughness(1.0), 2.0));
        assert!(close(shininess_from_roughness(0.0), 1024.0)); // clamped
        let neutral = shininess_from_roughness(NEUTRAL_ROUGHNESS);
        assert!(neutral > 40.0 && neutral < 60.0); // 2 / 0.45^4 ≈ 48.8
    }

    #[test]
    fn append_primitive_tracks_ranges_and_rebases_indices() {
        let mut mesh = MeshData::default();
        mesh.append_primitive(
            vec![[0.0; 3]; 3],
            vec![[0.0, 0.0, 1.0]; 3],
            vec![[1.0; 3]; 3],
            vec![[0.0, 0.0]; 3],
            vec![0, 1, 2],
            [1.0; 4],
            0.0,
            1.0,
            None,
        );
        mesh.append_primitive(
            vec![[1.0; 3]; 4],
            vec![[0.0, 0.0, 1.0]; 4],
            vec![[0.5; 3]; 4],
            vec![[1.0, 1.0]; 4],
            vec![0, 1, 2, 0, 2, 3],
            [0.5, 0.5, 0.5, 1.0],
            1.0,
            0.2,
            Some(0),
        );
        assert_eq!(mesh.positions.len(), 7);
        assert_eq!(mesh.primitives.len(), 2);
        assert_eq!((mesh.primitives[0].start, mesh.primitives[0].count), (0, 3));
        assert_eq!((mesh.primitives[1].start, mesh.primitives[1].count), (3, 6));
        // second primitive's indices are rebased past the first's vertices
        assert_eq!(&mesh.indices[3..], &[3, 4, 5, 3, 5, 6]);
        assert_eq!(mesh.primitives[1].texture, Some(0));
        // interleave: 11 floats per vertex, uv in the last two lanes
        let verts = interleave(&mesh);
        assert_eq!(verts.len(), 7 * 11);
        assert_eq!(&verts[9..11], &[0.0, 0.0]); // vertex 0 uv
        assert_eq!(&verts[3 * 11 + 9..3 * 11 + 11], &[1.0, 1.0]); // vertex 3 uv
    }

    #[test]
    fn prim_uniform_packs_factor_metallic_and_shininess() {
        let prim = MeshPrimitive {
            start: 0,
            count: 3,
            base_color: [0.2, 0.4, 0.6, 1.0],
            metallic: NEUTRAL_METALLIC,
            roughness: NEUTRAL_ROUGHNESS,
            texture: None,
        };
        let u = pack_prim_uniform(&prim);
        assert_eq!(&u[0..4], &[0.2, 0.4, 0.6, 1.0]);
        assert!(close(u[4], 0.25));
        assert!(close(u[5], shininess_from_roughness(0.45)));
    }

    #[test]
    fn rig_colors_are_linearized_before_intensity_scaling() {
        // Landscape key = magenta 0xe879f9: sRGB 0.9098 → linear ~0.8122.
        let lit = rig_light(&LANDSCAPE_RIG, 1.0, 0.0);
        let expect = srgb_to_linear(0xe8 as f32 / 255.0) * LANDSCAPE_RIG.key_intensity;
        assert!(close(lit.key_color[0], expect));
        // Cyan rim green channel: 0xd3 linearized then scaled.
        let expect = srgb_to_linear(0xd3 as f32 / 255.0) * LANDSCAPE_RIG.rim_intensity;
        assert!(close(lit.rim_color[1], expect));
        // White ambient is linear-invariant.
        assert!(close(lit.ambient[0], LANDSCAPE_RIG.ambient));
    }

    #[test]
    fn scene_mesh_linearizes_srgb_palette_colors() {
        let mesh = scene_mesh(
            &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            &[0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
            &[0, 1, 2],
        )
        .unwrap();
        assert!(close(mesh.colors[0][0], srgb_to_linear(0.5)));
        assert_eq!(mesh.primitives.len(), 1);
        assert_eq!(mesh.primitives[0].count, 3);
        assert!(close(mesh.primitives[0].roughness, 1.0));
        assert!(close(mesh.primitives[0].metallic, 0.0));
    }

    #[test]
    fn flight_uniform_rotates_light_dirs_into_view_space() {
        let s = std::f32::consts::FRAC_1_SQRT_2;
        // Camera yawed 90°: world -z maps to view ... check via the rig.
        let ext = FlightDraw {
            cam: [0.0, 0.0, 0.0],
            quat: [0.0, s, 0.0, s],
            tile_z: [0.0, -9.0],
            tile_scale_y: 1.0,
            brightness: 1.0,
            light_angle: 0.0,
            visible: true,
            fov_deg: 64.0,
        };
        let u = pack_flight_uniform(&ext, 0, 1.0, 9.0, &LANDSCAPE_RIG, [0.0; 3], 1.0);
        let world = rig_light(&LANDSCAPE_RIG, 1.0, 0.0);
        // 90° yaw about +y: view = R(q)ᵀ ⇒ (x, y, z) → (-z, y, x).
        assert!(close(u[48], -world.key_dir[2]));
        assert!(close(u[49], world.key_dir[1]));
        assert!(close(u[50], world.key_dir[0]));
    }

    #[test]
    fn model_normalization_centers_and_scales_to_2_2() {
        let mut mesh = quad_mesh([1.0, 2.0, 3.0], [5.0, 4.0, 3.5]);
        // sizes (4, 2, 0.5): maxDim 4 → scale 0.55, center (3, 3, 3.25)
        bake_model_normalization(&mut mesh);
        let b = super::bbox(&mesh.positions);
        assert!(close(b.min[0], -2.2 / 2.0) && close(b.max[0], 2.2 / 2.0));
        assert!(close(b.min[1] + b.max[1], 0.0));
        assert!(close(b.min[2] + b.max[2], 0.0));
        assert!(close(b.max[1] - b.min[1], 2.0 * 0.55));
    }

    #[test]
    fn tile_layout_normalizes_grounds_and_measures_span() {
        // bbox x 1..3, y 1..5, z -2..8: sizes (2, 4, 10)
        let mut mesh = quad_mesh([1.0, 1.0, -2.0], [3.0, 5.0, 8.0]);
        let layout = bake_tile_layout(&mut mesh, true, true);
        // widest horizontal axis = z = 10 → s = 9/10
        assert!(close(layout.base_scale, 0.9));
        assert!(close(layout.span, 9.0)); // 10 * 0.9
        assert!(close(layout.height, 3.6)); // 4 * 0.9
        let b = super::bbox(&mesh.positions);
        // grounded: bbox rests on y=0; x/z centred (offsets baked pre-scale)
        assert!(close(b.min[1], 0.0));
        assert!(close(b.min[0] + b.max[0], 0.0));
        assert!(close(b.min[2] + b.max[2], 0.0));
    }

    #[test]
    fn tile_layout_without_normalize_keeps_units_and_centers() {
        let mut mesh = quad_mesh([0.0, 2.0, -1.0], [2.0, 6.0, 1.0]);
        let layout = bake_tile_layout(&mut mesh, false, false);
        assert!(close(layout.base_scale, 1.0));
        assert!(close(layout.span, 2.0));
        assert!(close(layout.height, 4.0));
        let b = super::bbox(&mesh.positions);
        assert!(close(b.min[1] + b.max[1], 0.0)); // centred, not grounded
    }

    #[test]
    fn landscape_meta_matches_both_fly_modes() {
        let layout = TileLayout {
            base_scale: 0.9,
            span: 9.0,
            height: 3.6,
        };
        let (span, cam) = landscape_meta(&layout, false);
        assert!(close(span, 9.0) && close(cam, 3.6 * 0.55 + 0.5));
        let (span, cam) = landscape_meta(&layout, true);
        assert!(close(span, 9.0) && close(cam, 0.0));
        // tiny meshes clamp: span ≥ 1, height ≥ .01
        let mut flat = quad_mesh([0.0, 0.0, 0.0], [1.0, 0.0, 0.1]);
        let layout = bake_tile_layout(&mut flat, false, true);
        assert!(close(layout.span, 1.0));
        let (_, cam) = landscape_meta(&layout, false);
        assert!(close(cam, 0.01 * 0.55 + 0.5));
    }

    #[test]
    fn scene_mesh_pads_colors_and_defaults_indices() {
        let mesh = scene_mesh(
            &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            &[1.0, 0.0, 0.0], // only one colour supplied
            &[],
        )
        .unwrap();
        assert_eq!(mesh.indices, vec![0, 1, 2]);
        assert_eq!(mesh.colors[0], [1.0, 0.0, 0.0]);
        assert_eq!(mesh.colors[1], [1.0, 1.0, 1.0]);
        // CCW triangle in the xy plane → +z normal
        assert!(close(mesh.normals[0][2], 1.0));
        assert!(scene_mesh(&[], &[], &[]).is_err());
        assert!(scene_mesh(&[0.0, 0.0, 0.0], &[], &[0, 1, 2]).is_err());
    }

    #[test]
    fn rig_light_scales_brightness_and_orbits_the_key() {
        // landscape key sits at (0, 2, -6): base angle atan2(0, -6) = π
        let lit = rig_light(&LANDSCAPE_RIG, 1.0, 0.0);
        let d = lit.key_dir;
        assert!(close(d[0], 0.0) && d[2] < 0.0 && d[1] > 0.0);
        // brightness 0 kills the whole rig
        let dark = rig_light(&LANDSCAPE_RIG, 0.0, 0.0);
        assert_eq!(dark.ambient, [0.0; 3]);
        assert_eq!(dark.key_color, [0.0; 3]);
        assert_eq!(dark.rim_color, [0.0; 3]);
        // +π/2 swings the key from -z toward -x; height and rim stay put
        let turned = rig_light(&LANDSCAPE_RIG, 1.0, std::f32::consts::FRAC_PI_2);
        assert!(turned.key_dir[0] < -0.9);
        assert!(close(turned.key_dir[2], 0.0));
        assert_eq!(turned.rim_dir, lit.rim_dir);
    }

    #[test]
    fn mesh_uniform_packs_fog_and_lights_at_wgsl_offsets() {
        let ext = FlightDraw {
            cam: [0.0, 1.0, 2.0],
            quat: [0.0, 0.0, 0.0, 1.0],
            tile_z: [0.0, -9.0],
            tile_scale_y: 1.0,
            brightness: 1.0,
            light_angle: 0.0,
            visible: true,
            fov_deg: 64.0,
        };
        let u = pack_flight_uniform(&ext, 1, 0.9, 9.0, &SCENE_RIG, [0.1, 0.2, 0.3], 16.0 / 9.0);
        // fog block: color rgb + enable, then near/far = span*0.3 / span*1.9
        assert!(close(u[64], 0.1) && close(u[65], 0.2) && close(u[66], 0.3));
        assert!(close(u[67], 1.0));
        assert!(close(u[68], 2.7) && close(u[69], 17.1));
        // model_view (identity camera rotation): scale diag (s, 1, -s) shows
        // the tile-1 z mirror; translation = tileZ - cam = (0, -1, -11)
        assert!(close(u[16], 0.9) && close(u[16 + 5], 1.0) && close(u[16 + 10], -0.9));
        assert!(close(u[16 + 12], 0.0) && close(u[16 + 13], -1.0) && close(u[16 + 14], -11.0));

        let m = ModelDraw {
            pos: [0.0, 0.0, 0.0],
            quat: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
            brightness: 1.0,
            light_angle: 0.0,
            visible: true,
        };
        let u = pack_model_uniform(&m, 16.0 / 9.0);
        // no fog for models
        assert!(close(u[67], 0.0));
        // identity model, camera at z=4: model_view translation z = -4
        assert!(close(u[16 + 14], -4.0));
        // ambient = 0.5 white
        assert!(close(u[44], 0.5) && close(u[45], 0.5) && close(u[46], 0.5));
    }
}
