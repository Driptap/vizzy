// LLM shader ingestion: wrap a generated GLSL fragment *body* (helpers +
// `void main()`, written against the WebGL-era contract: vUv, u_time,
// u_resolution, u_audio_*, gl_FragColor) in a Vulkan-style GLSL 450 header
// and validate it through naga — the same frontend wgpu compiles it with, so
// a body that passes here builds a real pipeline, and a body that fails here
// returns an error string for the LLM repair loop.
use wgpu::naga;

/// Uniforms every deck shader sees. std140: vec2 first, then five floats —
/// 28 bytes padded to 32. The Rust-side buffer layout must match (see
/// `DeckParams` in the render engine).
pub const DECK_HEADER: &str = "#version 450
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 vizzyFragColor;
#define gl_FragColor vizzyFragColor
#define texture2D texture
layout(set = 0, binding = 0, std140) uniform VizzyDeckParams {
    vec2 u_resolution;
    float u_time;
    float u_audio_low;
    float u_audio_mid;
    float u_audio_high;
    float u_audio_level;
};
";

/// Lines the LLM tends to emit out of WebGL habit that are illegal or
/// redundant under GLSL 450: precision statements, #version, and
/// redeclarations of the header's interface. The TS parser already strips
/// most of these; this is the defensive last pass in front of naga.
fn sanitize_body(body: &str) -> String {
    body.lines()
        .filter(|line| {
            let t = line.trim();
            !(t.starts_with("precision ")
                || t.starts_with("#version")
                || t.starts_with("varying ")
                || is_header_redeclaration(t))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_header_redeclaration(line: &str) -> bool {
    const HEADER_SYMBOLS: [&str; 7] = [
        "u_time",
        "u_resolution",
        "u_audio_low",
        "u_audio_mid",
        "u_audio_high",
        "u_audio_level",
        "vUv",
    ];
    let is_decl = line.starts_with("uniform ") || line.starts_with("in ");
    is_decl && HEADER_SYMBOLS.iter().any(|s| line.contains(s))
}

/// Full GLSL 450 source for a generated body.
pub fn deck_shader_source(body: &str) -> String {
    format!("{DECK_HEADER}\n{}\n", sanitize_body(body))
}

/// Parse + validate a deck shader body. Ok(module) is ready for pipeline
/// creation; Err carries a naga error rendered against the full source,
/// which feeds the regenerate-with-error repair loop.
pub fn validate_deck_shader(body: &str) -> Result<naga::Module, String> {
    let source = deck_shader_source(body);
    parse_and_validate(&source)
}

fn parse_and_validate(source: &str) -> Result<naga::Module, String> {
    let mut frontend = naga::front::glsl::Frontend::default();
    let options = naga::front::glsl::Options::from(naga::ShaderStage::Fragment);
    let mut module = frontend
        .parse(&options, source)
        .map_err(|errors| errors.emit_to_string(source))?;
    normalize_fragment_io(&mut module);

    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .map_err(|err| err.emit_to_string(source))?;

    Ok(module)
}

/// The GLSL frontend leaves input interpolation/sampling unset; the WGSL
/// vertex stage outputs default to perspective/center, and wgpu requires the
/// stage interfaces to match exactly. Pin the fragment inputs to the same.
fn normalize_fragment_io(module: &mut naga::Module) {
    for ep in module.entry_points.iter_mut() {
        for arg in ep.function.arguments.iter_mut() {
            if let Some(naga::Binding::Location {
                interpolation,
                sampling,
                ..
            }) = arg.binding.as_mut()
            {
                if interpolation.is_none() {
                    *interpolation = Some(naga::Interpolation::Perspective);
                }
                if sampling.is_none() {
                    *sampling = Some(naga::Sampling::Center);
                }
            }
        }
    }
}

/// The startup shaders, ported from src/engine/shaders.ts (makeDefaultBody):
/// same body, one phase per deck so each starts on a different hue.
pub fn default_deck_body(phase: f32) -> String {
    format!(
        "void main() {{
  vec2 uv = vUv;
  float pulse = 0.55 + 0.45 * sin(u_time * 1.5 + {phase:.1});
  vec3 base = 0.5 + 0.5 * cos(u_time * 0.4 + uv.xyx * 3.0 + vec3({phase:.1}, {p2:.1}, {p4:.1}));
  float glow = smoothstep(0.95, 0.15, distance(uv, vec2(0.5)));
  vec3 col = base * (0.2 + 0.8 * pulse) * glow;
  col += vec3(u_audio_low, u_audio_mid, u_audio_high) * 0.45 * glow;
  col += u_audio_level * 0.1;
  gl_FragColor = vec4(col, 1.0);
}}",
        phase = phase,
        p2 = phase + 2.0,
        p4 = phase + 4.0,
    )
}

pub const DEFAULT_DECK_PHASES: [f32; 8] = [0.0, 1.6, 3.1, 4.7, 0.8, 2.4, 3.9, 5.5];

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_valid(body: &str) {
        if let Err(e) = validate_deck_shader(body) {
            panic!("expected body to validate, got:\n{e}");
        }
    }

    #[test]
    fn default_bodies_validate() {
        for phase in DEFAULT_DECK_PHASES {
            assert_valid(&default_deck_body(phase));
        }
    }

    // Corpus of LLM-typical shader patterns: each exercises constructs
    // qwen2.5-coder reliably emits for the 6 style recipes.

    #[test]
    fn raymarcher_with_helpers_validates() {
        assert_valid(
            r#"
float sdSphere(vec3 p, float r) { return length(p) - r; }
float map(vec3 p) {
  p.xz = mod(p.xz + 2.0, 4.0) - 2.0;
  return sdSphere(p, 1.0 + 0.3 * sin(u_time + u_audio_low * 6.0));
}
vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)));
}
void main() {
  vec2 uv = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 ro = vec3(0.0, 0.0, u_time);
  vec3 rd = normalize(vec3(uv, 1.0));
  float t = 0.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);
    if (d < 0.001) {
      vec3 n = calcNormal(p);
      col = 0.5 + 0.5 * n;
      col *= 1.0 - t * 0.05;
      break;
    }
    t += d;
    if (t > 20.0) break;
  }
  gl_FragColor = vec4(col, 1.0);
}
"#,
        );
    }

    #[test]
    fn tunnel_with_polar_math_validates() {
        assert_valid(
            r#"
void main() {
  vec2 uv = vUv - 0.5;
  float a = atan(uv.y, uv.x);
  float r = length(uv);
  vec2 t = vec2(a / 6.28318 + u_time * 0.1, 0.3 / max(r, 0.001) + u_time);
  float bands = smoothstep(0.4, 0.6, fract(t.y * 2.0 + sin(t.x * 12.0)));
  vec3 col = mix(vec3(0.1, 0.0, 0.3), vec3(0.0, 0.9, 1.0), bands);
  col *= r * 2.5;
  col *= 1.0 + u_audio_level * 1.5;
  gl_FragColor = vec4(col, 1.0);
}
"#,
        );
    }

    #[test]
    fn fractal_with_define_and_mat2_validates() {
        assert_valid(
            r#"
#define ITER 48
mat2 rot(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }
void main() {
  vec2 z = (vUv - 0.5) * 3.0;
  z *= rot(u_time * 0.1);
  vec2 c = vec2(-0.745, 0.186 + 0.05 * sin(u_time * 0.3) + u_audio_mid * 0.1);
  float m = 0.0;
  for (int i = 0; i < ITER; i++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 4.0) { m = float(i) / float(ITER); break; }
  }
  vec3 col = 0.5 + 0.5 * cos(6.28318 * (m + vec3(0.0, 0.33, 0.67)) + u_time * 0.2);
  gl_FragColor = vec4(col * step(0.001, m), 1.0);
}
"#,
        );
    }

    #[test]
    fn spectrum_bars_with_arrays_validate() {
        assert_valid(
            r#"
void main() {
  float bands[4] = float[4](u_audio_low, u_audio_mid, u_audio_high, u_audio_level);
  float x = vUv.x * 4.0;
  int idx = int(min(floor(x), 3.0));
  float level = bands[idx];
  float bar = step(vUv.y, level);
  float edge = smoothstep(0.02, 0.0, abs(fract(x) - 0.5) - 0.42);
  vec3 col = mix(vec3(0.0, 0.2, 0.05), vec3(0.2, 1.0, 0.4), vUv.y) * bar * edge;
  gl_FragColor = vec4(col, 1.0);
}
"#,
        );
    }

    #[test]
    fn frag_coord_usage_validates() {
        assert_valid(
            r#"
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec3 col = vec3(uv, 0.5 + 0.5 * sin(u_time));
  gl_FragColor = vec4(col, 1.0);
}
"#,
        );
    }

    #[test]
    fn sanitizer_strips_webgl_era_lines() {
        let body = "precision highp float;
varying vec2 vUv;
uniform float u_time;
#version 300 es
void main() { gl_FragColor = vec4(vec3(sin(u_time)), 1.0); }";
        assert_valid(body);
        let cleaned = sanitize_body(body);
        assert!(!cleaned.contains("precision"));
        assert!(!cleaned.contains("varying"));
        assert!(!cleaned.contains("uniform float u_time"));
        assert!(!cleaned.contains("#version"));
    }

    #[test]
    fn broken_shader_reports_an_error_with_context() {
        let err = validate_deck_shader("void main() { gl_FragColor = vec4(notdefined, 1.0); }")
            .unwrap_err();
        assert!(
            err.contains("notdefined"),
            "error should name the symbol: {err}"
        );
    }
}
