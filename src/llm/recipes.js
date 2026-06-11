// Style recipes: compact, technique-dense guidance blocks appended to the
// system prompt ONLY when the user's prompt matches — keeps the local model's
// context small (one recipe max) while sharply raising output quality for
// known visual genres. No backticks/${ in guidance bodies (template literals).

export const STYLE_RECIPES = [
  {
    id: 'fractal',
    title: 'Escape-time fractals (Mandelbrot / Julia)',
    keywords: ['fractal', 'mandelbrot', 'julia', 'mandel', 'kaleido', 'ifs', 'escape'],
    guidance: `Use an escape-time loop with a CONSTANT iteration count (GLSL requires it; 48-64 is plenty):
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 c = 0.7885 * vec2(cos(u_time * 0.23), sin(u_time * 0.17)); // animated Julia seed
  vec2 z = p * 2.6;
  float n = 0.0;
  for (int i = 0; i < 56; i++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 16.0) break;
    n += 1.0;
  }
Smooth the bands: float m = n - log2(log2(max(dot(z, z), 16.0))) + 4.0;
Colour with a cosine palette: vec3 col = 0.5 + 0.5 * cos(6.2831 * (m * 0.03 + u_time * 0.02 + vec3(0.0, 0.33, 0.67)));
Good moves: slow exponential zoom (scale p by exp(-fract(u_time*0.05)*2.0)), drive the seed radius or palette speed with u_audio_low, brighten interior points (n == max) to black or deep glow. For Mandelbrot instead: c = p * 2.5 - vec2(0.5, 0.0); z = vec2(0.0).`,
  },
  {
    id: 'tunnel',
    title: 'Polar tunnels / wormholes',
    keywords: ['tunnel', 'wormhole', 'worm hole', 'vortex', 'warp', 'hyperspace', 'portal'],
    guidance: `Classic polar tunnel: map the screen to (depth, angle) coordinates.
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float r = length(p) + 0.0001;
  float a = atan(p.y, p.x);
  float depth = 0.25 / r + u_time * (0.8 + u_audio_level); // fly forward
  float twist = a + 1.5 / r * 0.2 + u_time * 0.2;          // optional spiral
Pattern the walls procedurally from (depth, twist): rings = sin(depth * 8.0), spokes = sin(twist * 6.0), grids = both multiplied; combine and palette-colour.
CRITICAL: darken the centre to hide the 1/r singularity: col *= smoothstep(0.0, 0.5, r); and fade the far end with col *= r * 2.0 or exp(-0.5 / r).
Audio: speed from u_audio_level, wall brightness pulses from u_audio_low, spoke count or twist from u_audio_mid. Wormhole feel = add a second tunnel offset slightly and mix, or wobble the centre: p += 0.1 * vec2(sin(u_time * 0.7), cos(u_time * 0.9)).`,
  },
  {
    id: 'raymarch',
    title: 'Raymarched 3D scenes',
    keywords: ['3d', 'raymarch', 'ray march', 'sphere', 'torus', 'cube', 'sdf', 'landscape', 'terrain'],
    guidance: `Sphere-trace a signed distance field with a CONSTANT step count (keep it <= 64 for performance):
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 ro = vec3(0.0, 0.0, u_time * 1.5);          // camera flies forward
  vec3 rd = normalize(vec3(p, 1.0));
  float t = 0.0;
  for (int i = 0; i < 56; i++) {
    vec3 q = ro + rd * t;
    float d = length(mod(q + 2.0, 4.0) - 2.0) - 0.6; // infinite repeated spheres
    if (d < 0.001 || t > 30.0) break;
    t += d;
  }
Shade cheaply: normal n = normalize(vec3(sdf(q+e.xyy)-sdf(q-e.xyy), ...)) with e=vec2(0.01,0); or skip normals and colour by distance: vec3 col = palette(t * 0.1) * exp(-t * 0.12).
Space repetition (mod) is the cheapest way to make it feel infinite. Twist space for organic motion: rotate q.xy by q.z * 0.1 + u_time * 0.05. Audio: pulse the SDF radius with u_audio_low (breathing geometry), camera roll from u_audio_mid. Always fog: exp(-t * k) or the far field shimmers.`,
  },
  {
    id: 'ribbon',
    title: 'Vib-Ribbon style vector line art',
    keywords: ['vib', 'ribbon', 'wireframe', 'line art', 'vector', 'oscilloscope', 'waveform', 'minimal line'],
    guidance: `Aesthetic: stark 1-bit look — thin clean lines on a flat near-black (or near-white) background, no gradients or glow washes.
Draw a function as an anti-aliased line:
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float y = 0.15 * sin(p.x * 6.0 + u_time * 2.0)
          + 0.10 * sin(p.x * 13.0 - u_time * 3.0) * u_audio_mid
          + 0.08 * sign(sin(p.x * 20.0)) * u_audio_high; // hard angular kinks
  float d = abs(p.y - y);
  float line = smoothstep(0.012, 0.004, d);
Layer 2-3 such ribbons with phase offsets and slightly different brightness. Add sparse geometric obstacles riding the line (small squares/spikes): box(p - vec2(fract stepped x, y)). Keep the palette to one ink colour + background; flash inverted (1.0 - col) for a single frame feel when u_audio_low > 0.8. A subtle screen wobble — p += 0.005 * sin(u_time * 31.0) * u_audio_high — sells the hand-drawn jitter.`,
  },
  {
    id: 'winamp',
    title: 'Winamp / Milkdrop spectrum style',
    keywords: ['winamp', 'milkdrop', 'avs', 'spectrum', 'equalizer', 'eq bars', 'bars', 'analyzer'],
    guidance: `IMPORTANT: only 4 audio scalars exist (u_audio_low/mid/high/level) — there is NO spectrum array and NO previous-frame texture. Fake a full spectrum with per-column variation:
  float cols = 24.0;
  float i = floor(vUv.x * cols);
  float hash = fract(sin(i * 127.1) * 43758.5453);
  float band = mix(u_audio_low, mix(u_audio_mid, u_audio_high, smoothstep(8.0, 24.0, i)), smoothstep(0.0, 8.0, i));
  float h = band * (0.5 + 0.5 * fract(sin((i + floor(u_time * 9.0)) * 311.7) * 1573.96));
  float bar = step(vUv.y, h) * step(0.15, fract(vUv.x * cols)); // gaps between bars
Colour bars by height (green->yellow->red ramp or a cosine palette on i / cols). Add a peak cap: step(abs(vUv.y - h), 0.01).
Milkdrop flavour: put the bars in polar coordinates (angle = column) around the centre, layer a slowly rotating kaleidoscope of the same field (sample with mirrored angle fract), and pulse global brightness with u_audio_level. Trails are impossible without feedback — emulate motion blur by summing the pattern at 3 slightly offset phases with falling weights.`,
  },
  {
    id: 'itunes',
    title: 'iTunes visualizer style (flowing glow particles)',
    keywords: ['itunes', 'particle', 'particles', 'swirl', 'nebula', 'flow', 'orbs', 'magnetosphere'],
    guidance: `Additive glowing orbs swirling around the centre, hue-cycling, soft and liquid:
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    float h1 = fract(sin(fi * 12.9898) * 43758.5453);
    float h2 = fract(sin(fi * 78.233) * 12543.21);
    float ang = h1 * 6.2831 + u_time * (0.2 + 0.6 * h2) * (h1 > 0.5 ? 1.0 : -1.0);
    float rad = 0.12 + 0.35 * h2 + 0.15 * u_audio_low;
    vec2 pos = rad * vec2(cos(ang), sin(ang));
    vec3 hue = 0.5 + 0.5 * cos(6.2831 * (h1 + u_time * 0.05 + vec3(0.0, 0.33, 0.67)));
    col += hue * 0.0035 / max(length(p - pos), 0.02); // additive glow falloff
  }
Then swirl the whole field: rotate p before the loop by an angle proportional to length(p) and u_time (rot(a): mat2(cos a, -sin a, sin a, cos a)). Tone-map so it never clips ugly: col = col / (1.0 + col). Audio: orbit radius breathes with u_audio_low, glow gain with u_audio_level, a brief white-core flash on u_audio_high. Background stays pure black.`,
  },
];

// Best single match wins; ties broken by keyword specificity (longer match).
export function selectRecipe(userPrompt) {
  const text = (userPrompt || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  STYLE_RECIPES.forEach((recipe) => {
    let score = 0;
    recipe.keywords.forEach((kw) => {
      if (text.includes(kw)) score += kw.length;
    });
    if (score > bestScore) {
      best = recipe;
      bestScore = score;
    }
  });
  return best;
}
