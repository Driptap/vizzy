// Non-shader deck passes: sprite quads and lit meshes (models, landscapes,
// procedural scenes), drawn into the per-deck offscreen targets.
//
// Orientation: deck targets are stored bottom-up (see compositor.wgsl). Both
// vertex stages compute y-UP clip coordinates (the contract's convention,
// matching the three.js math on the TS side) and negate y on output so the
// content lands bottom-up like everything else. The negation flips triangle
// winding — mesh pipelines declare front_face = Cw to compensate.

// ------------------------------------------------------------------ sprite

struct SpriteUniforms {
  // m00, m01, m10, m11 — row-major 2x2 acting on the unit-square corners
  m: vec4<f32>,
  // tx, ty, distort, skew
  t: vec4<f32>,
  // opacity, time (render-thread), unused, unused
  o: vec4<f32>,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var sprite_tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> sprite: SpriteUniforms;

struct SpriteVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_sprite(@builtin(vertex_index) vi: u32) -> SpriteVsOut {
  // 4-vertex triangle strip over the unit square, corners c = (±0.5, ±0.5)
  let c = vec2<f32>(f32(vi & 1u) - 0.5, f32(vi >> 1u) - 0.5);
  var out: SpriteVsOut;
  out.pos = vec4<f32>(
    sprite.m.x * c.x + sprite.m.y * c.y + sprite.t.x,
    -(sprite.m.z * c.x + sprite.m.w * c.y + sprite.t.y),
    0.0,
    1.0,
  );
  // (0,0) = bottom-left of the upright image; rows were flipped at upload
  out.uv = c + vec2<f32>(0.5);
  return out;
}

// Port of shaders.ts SPRITE_FRAGMENT: skew shear, sine distort, transparent
// outside the warped [0,1] square.
@fragment
fn fs_sprite(in: SpriteVsOut) -> @location(0) vec4<f32> {
  var uv = in.uv;
  let time = sprite.o.y;
  uv.x = uv.x + sprite.t.w * (uv.y - 0.5);
  uv = uv + sprite.t.z * 0.08 * vec2<f32>(
    sin(uv.y * 12.0 + time * 5.0),
    sin(uv.x * 10.0 + time * 4.0),
  );
  let inside = step(vec2<f32>(0.0), uv) * step(uv, vec2<f32>(1.0));
  let t = textureSample(sprite_tex, samp, uv);
  return vec4<f32>(t.rgb, t.a * sprite.o.x * inside.x * inside.y);
}

// -------------------------------------------------------------------- mesh
//
// Colour space: every mesh input is LINEAR by the time it reaches fs_mesh —
// vertex colours and rig constants are linearized CPU-side, the base-colour
// texture decodes in hardware (Rgba8UnormSrgb view) — lighting and fog mix in
// linear, and the final colour is sRGB-ENCODED before the Rgba8Unorm deck
// target write, matching three.js's outputColorSpace = sRGB. Shader/sprite
// decks stay display-referred and untouched.

struct MeshUniforms {
  mvp: mat4x4<f32>,
  model_view: mat4x4<f32>,
  // view-space normal matrix columns (inverse-transpose of model-view 3x3)
  n0: vec4<f32>,
  n1: vec4<f32>,
  n2: vec4<f32>,
  // THREE-style rig: ambient + two directional lights, LINEAR colours
  // premultiplied by intensity, VIEW-space directions pointing TOWARD the
  // light (three lights in view space too).
  ambient: vec4<f32>,
  key_dir: vec4<f32>,
  key_color: vec4<f32>,
  rim_dir: vec4<f32>,
  rim_color: vec4<f32>,
  // rgb (linear) + enable (0 for models, 1 for flight decks)
  fog_color: vec4<f32>,
  // near, far, unused, unused
  fog_range: vec4<f32>,
}

// Per-primitive material (one bind group per glTF primitive; untextured
// primitives bind a shared 1x1 white texture so the sample is a no-op).
struct PrimUniforms {
  // linear base-colour factor (rgb; a unused)
  base_color: vec4<f32>,
  // metallic, Blinn-Phong shininess (from roughness, CPU-side), unused x2
  material: vec4<f32>,
}

// binding 3: keeps the module free of group/binding collisions with the
// sprite declarations above (each pipeline layout binds only what it uses).
@group(0) @binding(3) var<uniform> mesh: MeshUniforms;
@group(1) @binding(0) var mesh_samp: sampler;
@group(1) @binding(1) var base_tex: texture_2d<f32>;
@group(1) @binding(2) var<uniform> prim: PrimUniforms;

struct MeshVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec3<f32>,
  @location(2) view_pos: vec3<f32>,
  @location(3) uv: vec2<f32>,
}

@vertex
fn vs_mesh(
  @location(0) p: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(2) c: vec3<f32>,
  @location(3) uv: vec2<f32>,
) -> MeshVsOut {
  var out: MeshVsOut;
  var clip = mesh.mvp * vec4<f32>(p, 1.0);
  clip.y = -clip.y; // bottom-up deck target (header note)
  out.pos = clip;
  out.normal = mat3x3<f32>(mesh.n0.xyz, mesh.n1.xyz, mesh.n2.xyz) * n;
  out.color = c;
  // view-space position: -z is THREE's vFogDepth, -pos the view vector
  out.view_pos = (mesh.model_view * vec4<f32>(p, 1.0)).xyz;
  out.uv = uv;
  return out;
}

// Exact sRGB encode (the piecewise transfer function, not pow 1/2.2).
fn encode_srgb(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs_mesh(in: MeshVsOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  // sample before any divergent flow (uniformity) — hardware sRGB→linear
  let tex = textureSample(base_tex, mesh_samp, in.uv);
  var n = normalize(in.normal);
  // DoubleSide: the mirrored flight tile flips winding, so back faces shade
  // with the flipped normal (same trick THREE's Lambert uses).
  if (!front) {
    n = -n;
  }
  // three.js semantics: texture sample x factor x vertex colour (all linear)
  let base = tex.rgb * prim.base_color.rgb * in.color;
  let metallic = prim.material.x;
  let shininess = prim.material.y;
  let n_key = max(dot(n, mesh.key_dir.xyz), 0.0);
  let n_rim = max(dot(n, mesh.rim_dir.xyz), 0.0);
  // Diffuse (ambient included) loses energy as metalness rises — metals
  // reflect through the specular lobe instead of double-brightening.
  let lit = (mesh.ambient.rgb
    + mesh.key_color.rgb * n_key
    + mesh.rim_color.rgb * n_rim) * (1.0 - metallic * 0.7);
  var col = base * lit;
  // Blinn-Phong on the two directional lights only (ambient stays diffuse).
  let v = normalize(-in.view_pos);
  let spec_color = mix(vec3<f32>(0.04), base, metallic);
  let s_key = pow(max(dot(n, normalize(mesh.key_dir.xyz + v)), 0.0), shininess)
    * select(0.0, 1.0, n_key > 0.0);
  let s_rim = pow(max(dot(n, normalize(mesh.rim_dir.xyz + v)), 0.0), shininess)
    * select(0.0, 1.0, n_rim > 0.0);
  col += (mesh.key_color.rgb * s_key + mesh.rim_color.rgb * s_rim) * spec_color;
  // fog mixes in linear, like THREE, before the output encode
  let denom = max(mesh.fog_range.y - mesh.fog_range.x, 0.0001);
  let f = clamp((-in.view_pos.z - mesh.fog_range.x) / denom, 0.0, 1.0) * mesh.fog_color.w;
  col = mix(col, mesh.fog_color.rgb, f);
  // alpha 1 = coverage; the cleared background stays transparent
  return vec4<f32>(min(encode_srgb(max(col, vec3<f32>(0.0))), vec3<f32>(1.0)), 1.0);
}
