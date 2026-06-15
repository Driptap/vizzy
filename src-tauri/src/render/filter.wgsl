// Per-deck post filters. engine.rs runs one fullscreen pass per deck (only
// when some deck has a filter selected), sampling the deck's rendered target
// and writing a filtered copy the compositor then reads. One shader, one
// pipeline: the FilterUniform's `kind` selects the effect and `amount`/`param2`
// are its two generic 0..1 controls; DeckUniforms carries resolution/time/audio
// so filters can react to the music. The deck target is Rgba8Unorm stored
// bottom-up; uv is row-aligned (see vs_filter). Alpha is preserved as coverage
// except where a filter (luma key) deliberately rewrites it. The `kind` order
// must match FILTER_KINDS in params.rs and the FILTERS list in the UI.

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

struct DeckUniforms {
  resolution: vec2<f32>,
  time: f32,
  low: f32,
  mid: f32,
  high: f32,
  level: f32,
}

struct FilterUniform {
  // x: kind index, y: amount (0..1), z: param2 (0..1), w: pad
  params: vec4<f32>,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> F: FilterUniform;
@group(0) @binding(3) var<uniform> U: DeckUniforms;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_filter(@builtin(vertex_index) vi: u32) -> VsOut {
  let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vi & 2u) * 2.0 - 1.0;
  var out: VsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

fn samp_at(uv: vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(src, samp, uv, 0.0);
}

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

// Hue rotation by `a` radians: Rodrigues rotation of the colour vector about
// the achromatic (1,1,1) axis, which preserves luma.
fn hue_rotate(c: vec3<f32>, a: f32) -> vec3<f32> {
  let k = vec3<f32>(0.57735026); // 1/sqrt(3)
  let cosA = cos(a);
  return c * cosA + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cosA);
}

@fragment
fn fs_filter(in: VsOut) -> @location(0) vec4<f32> {
  let kind = u32(F.params.x + 0.5);
  let amount = F.params.y;
  let p2 = F.params.z;
  let uv = in.uv;
  let texel = 1.0 / max(U.resolution, vec2<f32>(1.0, 1.0));
  let c = samp_at(uv);
  var outc = c;

  switch kind {
    case 1u: { // invert
      outc = vec4<f32>(mix(c.rgb, 1.0 - c.rgb, amount), c.a);
    }
    case 2u: { // hue rotate
      outc = vec4<f32>(hue_rotate(c.rgb, amount * TAU), c.a);
    }
    case 3u: { // posterize
      let n = max(2.0, floor(mix(12.0, 2.0, amount)));
      outc = vec4<f32>(floor(c.rgb * n + 0.5) / n, c.a);
    }
    case 4u: { // pixelate
      let block = max(1.0, floor(mix(1.0, 80.0, amount)));
      let buv = (floor(uv * U.resolution / block) + 0.5) * block * texel;
      outc = samp_at(buv);
    }
    case 5u: { // scanlines / CRT
      let dens = mix(1.5, 4.0, p2);
      let s = 0.5 + 0.5 * sin(uv.y * U.resolution.y * PI / dens);
      outc = vec4<f32>(c.rgb * (1.0 - amount * (1.0 - s)), c.a);
    }
    case 6u: { // edge detect (Sobel on luma)
      let o = texel * (1.0 + p2 * 3.0);
      let tl = luma(samp_at(uv + vec2<f32>(-o.x, -o.y)).rgb);
      let tt = luma(samp_at(uv + vec2<f32>(0.0, -o.y)).rgb);
      let tr = luma(samp_at(uv + vec2<f32>(o.x, -o.y)).rgb);
      let ll = luma(samp_at(uv + vec2<f32>(-o.x, 0.0)).rgb);
      let rr = luma(samp_at(uv + vec2<f32>(o.x, 0.0)).rgb);
      let bl = luma(samp_at(uv + vec2<f32>(-o.x, o.y)).rgb);
      let bb = luma(samp_at(uv + vec2<f32>(0.0, o.y)).rgb);
      let br = luma(samp_at(uv + vec2<f32>(o.x, o.y)).rgb);
      let gx = (tr + 2.0 * rr + br) - (tl + 2.0 * ll + bl);
      let gy = (bl + 2.0 * bb + br) - (tl + 2.0 * tt + tr);
      let g = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
      outc = vec4<f32>(mix(c.rgb, vec3<f32>(g, g, g), amount), c.a);
    }
    case 7u: { // RGB split / chromatic aberration
      let ang = p2 * TAU;
      let d = vec2<f32>(cos(ang), sin(ang)) * amount * 0.06;
      let r = samp_at(uv + d);
      let b = samp_at(uv - d);
      outc = vec4<f32>(r.r, c.g, b.b, c.a);
    }
    case 8u: { // kaleidoscope
      let seg = floor(mix(2.0, 12.0, amount));
      let wedge = TAU / seg;
      let pol = uv - 0.5;
      let rad = length(pol);
      var ang = atan2(pol.y, pol.x) + p2 * TAU;
      ang = abs(((ang % wedge) + wedge) % wedge - wedge * 0.5);
      let kuv = clamp(vec2<f32>(cos(ang), sin(ang)) * rad + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
      outc = samp_at(kuv);
    }
    case 9u: { // swirl
      let pol = uv - 0.5;
      let rad = length(pol);
      let radius = mix(0.2, 0.9, p2);
      let falloff = max(0.0, 1.0 - rad / radius);
      let ang = amount * 6.0 * falloff * falloff;
      let ca = cos(ang);
      let sa = sin(ang);
      let rp = vec2<f32>(pol.x * ca - pol.y * sa, pol.x * sa + pol.y * ca) + 0.5;
      outc = samp_at(rp);
    }
    case 10u: { // box blur
      let r = texel * mix(0.0, 5.0, amount);
      var acc = vec4<f32>(0.0);
      for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
          acc = acc + samp_at(uv + vec2<f32>(f32(i), f32(j)) * r);
        }
      }
      outc = acc / 9.0;
    }
    case 11u: { // luma key
      let l = luma(c.rgb);
      let soft = max(0.001, p2 * 0.5);
      let a = smoothstep(amount - soft, amount + soft, l);
      outc = vec4<f32>(c.rgb, c.a * a);
    }
    case 12u: { // ripple (time + audio reactive)
      let pol = uv - 0.5;
      let rad = length(pol);
      let freq = mix(8.0, 60.0, p2);
      let amp = amount * 0.04 * (1.0 + U.level);
      let off = sin(rad * freq - U.time * 3.0) * amp;
      let dir = select(vec2<f32>(0.0, 0.0), pol / rad, rad > 1e-4);
      outc = samp_at(uv + dir * off);
    }
    default: {
    }
  }
  return outc;
}
