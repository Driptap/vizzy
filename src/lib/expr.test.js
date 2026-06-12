import { describe, it, expect } from 'vitest';
import { compileExpression } from './expr';

const evalExpr = (src, vars = {}) => compileExpression(src, Object.keys(vars))(vars);

describe('compileExpression', () => {
  it('handles arithmetic with standard precedence', () => {
    expect(evalExpr('1 + 2 * 3')).toBe(7);
    expect(evalExpr('(1 + 2) * 3')).toBe(9);
    expect(evalExpr('10 - 4 / 2')).toBe(8);
    expect(evalExpr('2 ^ 3 ^ 2')).toBe(512); // right-associative
    expect(evalExpr('-3 + 1')).toBe(-2);
  });

  it('substitutes variables', () => {
    expect(evalExpr('x * 2 + z', { x: 3, z: 1 })).toBe(7);
    expect(evalExpr('a', { a: 0.5 })).toBe(0.5);
  });

  it('supports the whitelisted function set', () => {
    expect(evalExpr('abs(sin(pi))')).toBeCloseTo(0);
    expect(evalExpr('max(2, min(5, 3))')).toBe(3);
    expect(evalExpr('pow(2, 10)')).toBe(1024);
    expect(evalExpr('fract(2.75)')).toBeCloseTo(0.75);
    expect(evalExpr('clamp(9, 0, 1)')).toBe(1);
    expect(evalExpr('mix(0, 10, 0.3)')).toBeCloseTo(3);
    expect(evalExpr('smoothstep(0, 1, 0.5)')).toBeCloseTo(0.5);
  });

  it('knows pi, tau and e', () => {
    expect(evalExpr('tau')).toBeCloseTo(Math.PI * 2);
    expect(evalExpr('PI')).toBeCloseTo(Math.PI); // case-insensitive constants
  });

  it('treats division by zero and non-finite results as 0', () => {
    expect(evalExpr('1 / 0')).toBe(0);
    expect(evalExpr('log(0)')).not.toBe(-Infinity);
  });

  it('rejects identifiers outside the sandbox', () => {
    expect(() => compileExpression('process', [])).toThrow(/Unknown identifier/);
    expect(() => compileExpression('window + 1', [])).toThrow(/Unknown identifier/);
    expect(() => compileExpression('require(1)', [])).toThrow(/Unknown function/);
    expect(() => compileExpression('y * 2', ['x', 'z'])).toThrow(/Unknown identifier "y"/);
  });

  it('rejects malformed expressions', () => {
    expect(() => compileExpression('', ['x'])).toThrow(/Empty/);
    expect(() => compileExpression('1 +', ['x'])).toThrow();
    expect(() => compileExpression('(1 + 2', ['x'])).toThrow();
    expect(() => compileExpression('1 2', ['x'])).toThrow(/trailing/);
    expect(() => compileExpression('x; alert(1)', ['x'])).toThrow(/Unexpected character/);
    expect(() => compileExpression('sin(1, 2)', [])).toThrow(/takes 1 argument/);
  });

  it('compiles a realistic terrain surface', () => {
    const fn = compileExpression(
      'abs(sin(x * 0.33 + sin(z * 0.21) * 1.4)) * min(1, abs(x) / 8) * 2.5',
      ['x', 'z'],
    );
    for (let x = -20; x <= 20; x += 5) {
      for (let z = 0; z <= 40; z += 10) {
        const v = fn({ x, z });
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
    expect(fn({ x: 0, z: 0 })).toBe(0); // valley corridor at x=0
  });
});
