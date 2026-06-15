import { describe, it, expect } from 'vitest';
import { parseSceneSpec, SCENE_SYSTEM_PROMPT, SCENE_EXAMPLES } from './scenes';

const VALID = '{"kind":"terrain","surface":"abs(sin(x*0.3))*min(1,abs(x)/8)","amplitude":3,"palette":["#ff71ce","#01cdfe","#1a0533"]}';

describe('parseSceneSpec', () => {
  it('accepts a clean JSON response', () => {
    const { spec, error } = parseSceneSpec(VALID);
    expect(error).toBeUndefined();
    expect(spec).toEqual({
      kind: 'terrain',
      surface: 'abs(sin(x*0.3))*min(1,abs(x)/8)',
      amplitude: 3,
      palette: ['#ff71ce', '#01cdfe', '#1a0533'],
    });
  });

  it('digs the JSON out of prose and markdown fences', () => {
    const { spec } = parseSceneSpec(`Sure! Here is your scene:\n\`\`\`json\n${VALID}\n\`\`\`\nEnjoy!`);
    expect(spec?.kind).toBe('terrain');
  });

  it('validates tunnel expressions against tunnel variables', () => {
    const ok = parseSceneSpec('{"kind":"tunnel","surface":"sin(a*8)+fract(z*0.5)","amplitude":2,"palette":[]}');
    expect(ok.spec?.kind).toBe('tunnel');
    // terrain variable in a tunnel surface is a hard error
    const bad = parseSceneSpec('{"kind":"tunnel","surface":"sin(x)","amplitude":2,"palette":[]}');
    expect(bad.error).toMatch(/Bad surface expression/);
  });

  it('rejects missing/invalid pieces with specific errors', () => {
    expect(parseSceneSpec('the model rambled with no JSON').error).toMatch(/No JSON object/);
    expect(parseSceneSpec('{"kind":"cube","surface":"1"}').error).toMatch(/terrain.*tunnel/);
    expect(parseSceneSpec('{"kind":"terrain"}').error).toMatch(/Missing "surface"/);
    expect(parseSceneSpec('{"kind":"terrain","surface":"window.alert"}').error).toMatch(/Bad surface/);
    expect(parseSceneSpec(null).error).toBeTruthy();
  });

  it('clamps amplitude and falls back on bad palette entries instead of failing', () => {
    const { spec } = parseSceneSpec(
      '{"kind":"terrain","surface":"sin(x)","amplitude":99,"palette":["#abcdef","nonsense"]}',
    );
    expect(spec.amplitude).toBe(5);
    expect(spec.palette[0]).toBe('#abcdef');
    expect(spec.palette[1]).toMatch(/^#[0-9a-f]{6}$/i); // fallback
    expect(spec.palette[2]).toMatch(/^#[0-9a-f]{6}$/i);

    const missing = parseSceneSpec('{"kind":"terrain","surface":"sin(x)"}');
    expect(missing.spec.amplitude).toBe(2); // default
  });
});

describe('SCENE_SYSTEM_PROMPT', () => {
  it('states the contract: JSON only, both kinds, the sandbox function list', () => {
    expect(SCENE_SYSTEM_PROMPT).toContain('ONLY a single JSON object');
    expect(SCENE_SYSTEM_PROMPT).toContain('"terrain" or "tunnel"');
    expect(SCENE_SYSTEM_PROMPT).toContain('smoothstep');
    expect(SCENE_SYSTEM_PROMPT).toContain('abs(x)/8'); // the corridor hint
  });

  it('guards against treating sibling fields as surface variables', () => {
    // the "Unknown identifier amplitude" failure: amplitude is a field, not a var
    expect(SCENE_SYSTEM_PROMPT).toContain('never write it inside surface');
    expect(SCENE_SYSTEM_PROMPT).toMatch(/amplitude, palette, kind.*are NOT variables/);
  });

  it('embeds the worked examples for few-shot grounding', () => {
    for (const ex of SCENE_EXAMPLES) {
      expect(SCENE_SYSTEM_PROMPT).toContain(ex.spec.surface);
    }
  });
});

describe('SCENE_EXAMPLES', () => {
  it('every example survives the same parse/compile path as model output', () => {
    expect(SCENE_EXAMPLES.length).toBeGreaterThan(0);
    for (const ex of SCENE_EXAMPLES) {
      const { spec, error } = parseSceneSpec(JSON.stringify(ex.spec));
      expect(error, `${ex.label} should compile`).toBeUndefined();
      expect(spec.surface).toBe(ex.spec.surface);
    }
  });
});
