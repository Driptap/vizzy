// First-launch example content: two shaders, a canvas-drawn PNG sprite and a
// procedurally generated STL torus, tied together in an "Example Deck"
// preset. Everything is synthesized at runtime — no binary assets shipped.
import { saveShader, saveDeck, saveAssetFromBuffer } from './shaderLibrary';

const PLASMA_BODY = `void main() {
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float t = u_time * 0.6;
  float v = sin(p.x * 4.0 + t)
          + sin(p.y * 3.0 - t * 1.3)
          + sin((p.x + p.y) * 5.0 + t * 0.7)
          + sin(length(p) * 8.0 - t * 2.0);
  v = v * 0.25 + 0.5;
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (v + u_time * 0.05 + vec3(0.0, 0.33, 0.67)));
  col *= 0.6 + 0.8 * u_audio_level;
  col += vec3(u_audio_low, u_audio_mid, u_audio_high) * 0.25;
  gl_FragColor = vec4(col, 1.0);
}`;

const RINGS_BODY = `void main() {
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float r = length(p);
  float rings = sin(r * 24.0 - u_time * 3.0 - u_audio_low * 6.0);
  float m = smoothstep(0.2, 0.9, rings);
  vec3 col = mix(vec3(0.02, 0.0, 0.05), vec3(0.1, 0.9, 1.0), m);
  col *= smoothstep(1.1, 0.2, r) * (0.5 + 0.8 * u_audio_level);
  gl_FragColor = vec4(col, 1.0);
}`;

function dataURLToBytes(dataURL) {
  const bin = atob(dataURL.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// simple gradient thumbnail with a label, for entries with no natural preview
function gradientThumb(label, colorA, colorB) {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 160, 90);
  grad.addColorStop(0, colorA);
  grad.addColorStop(1, colorB);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 160, 90);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, 80, 50);
  return canvas.toDataURL('image/jpeg', 0.8);
}

// neon ring + star on transparent ground, drawn at 512^2
function makeStarSprite() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 14;
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 45;
  for (let pass = 0; pass < 2; pass += 1) {
    ctx.beginPath();
    ctx.arc(c, c, 175, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#e879f9';
  ctx.shadowColor = '#e879f9';
  ctx.shadowBlur = 38;
  const star = new Path2D();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? 120 : 50;
    const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = c + radius * Math.cos(angle);
    const y = c + radius * Math.sin(angle);
    if (i === 0) star.moveTo(x, y);
    else star.lineTo(x, y);
  }
  star.closePath();
  ctx.fill(star);
  ctx.fill(star);

  // thumbnail: same image flattened onto black at library size
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 160;
  thumbCanvas.height = 90;
  const tctx = thumbCanvas.getContext('2d');
  tctx.fillStyle = '#000';
  tctx.fillRect(0, 0, 160, 90);
  tctx.drawImage(canvas, 35, 0, 90, 90);

  return {
    bytes: dataURLToBytes(canvas.toDataURL('image/png')),
    thumbnail: thumbCanvas.toDataURL('image/jpeg', 0.8),
  };
}

// binary STL torus — STLLoader recomputes vertex normals on load
function makeTorusSTL(R = 1.0, r = 0.45, segU = 48, segV = 24) {
  const point = (i, j) => {
    const u = (i / segU) * Math.PI * 2;
    const v = (j / segV) * Math.PI * 2;
    return [
      Math.cos(u) * (R + r * Math.cos(v)),
      Math.sin(u) * (R + r * Math.cos(v)),
      r * Math.sin(v),
    ];
  };
  const tris = [];
  for (let i = 0; i < segU; i += 1) {
    for (let j = 0; j < segV; j += 1) {
      const a = point(i, j);
      const b = point(i + 1, j);
      const cc = point(i + 1, j + 1);
      const d = point(i, j + 1);
      tris.push([a, b, cc], [a, cc, d]);
    }
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((tri, k) => {
    let o = 84 + k * 50;
    [[0, 0, 0], ...tri].forEach((vec) => {
      dv.setFloat32(o, vec[0], true);
      dv.setFloat32(o + 4, vec[1], true);
      dv.setFloat32(o + 8, vec[2], true);
      o += 12;
    });
  });
  return new Uint8Array(buf);
}

const defaultAut = () =>
  Object.fromEntries(['scl', 'rot', 'flk', 'dst', 'skw'].map((k) => [k, { amt: 0, audio: false }]));

const baseChannel = () => ({
  prompt: '',
  opacity: 0,
  muted: false,
  scale: 1,
  size: { x: 1, y: 1 },
  fx: { tilt: 0, contrast: 1, hue: 0, sat: 1, band: 'level', amt: 1 },
  aut: defaultAut(),
});

/** Creates the example entries + deck preset; returns them newest-first. */
export async function seedExampleLibrary() {
  const plasma = await saveShader({
    name: 'Example · Plasma Flow',
    code: PLASMA_BODY,
    screenshot: gradientThumb('PLASMA', '#0ea5e9', '#d946ef'),
  });
  const rings = await saveShader({
    name: 'Example · Neon Rings',
    code: RINGS_BODY,
    screenshot: gradientThumb('RINGS', '#0f172a', '#06b6d4'),
  });
  const starAsset = makeStarSprite();
  const sprite = await saveAssetFromBuffer({
    kind: 'sprite',
    name: 'Example · Neon Star',
    bytes: starAsset.bytes,
    ext: '.png',
    screenshot: starAsset.thumbnail,
  });
  const torus = await saveAssetFromBuffer({
    kind: 'model',
    name: 'Example · Torus',
    bytes: makeTorusSTL(),
    ext: '.stl',
    screenshot: gradientThumb('TORUS', '#0f172a', '#10b981'),
  });

  const channels = [
    {
      ...baseChannel(),
      shaderId: plasma.id,
      opacity: 1,
      prompt: 'flowing plasma waves reacting to the bass',
    },
    {
      ...baseChannel(),
      spriteId: sprite.id,
      opacity: 0.85,
      size: { x: 0.7, y: 0.7 },
      aut: { ...defaultAut(), scl: { amt: 0.55, audio: true }, rot: { amt: 0.12, audio: false } },
    },
    {
      ...baseChannel(),
      modelId: torus.id,
      opacity: 0.9,
      aut: { ...defaultAut(), rot: { amt: 0.35, audio: false }, dst: { amt: 0.3, audio: true } },
    },
    {
      ...baseChannel(),
      shaderId: rings.id,
      prompt: 'pulsing concentric neon rings',
    },
  ];
  const deck = await saveDeck({
    name: 'Example Deck',
    channels,
    screenshot: gradientThumb('EXAMPLE DECK', '#155e75', '#701a75'),
  });

  return { deck, entries: [deck, torus, sprite, rings, plasma] };
}
