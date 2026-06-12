// Tiny safe math-expression compiler for LLM-emitted surface functions.
// The model returns expressions like "abs(sin(x*0.3)+cos(z*0.2))*2"; we parse
// them into closures over a whitelisted function set. NEVER eval/Function on
// model output — this renderer has node integration.

export type ExprFn = (vars: Record<string, number>) => number;

const FUNCS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  abs: Math.abs,
  sqrt: (v) => Math.sqrt(Math.max(0, v)),
  pow: (b, e) => Math.pow(b, e),
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  fract: (v) => v - Math.floor(v),
  exp: Math.exp,
  log: (v) => Math.log(Math.max(1e-9, v)),
  sign: Math.sign,
  atan: Math.atan,
  atan2: Math.atan2,
  mod: (a, b) => (b === 0 ? 0 : ((a % b) + b) % b),
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  mix: (a, b, t) => a + (b - a) * t,
  step: (edge, v) => (v < edge ? 0 : 1),
  smoothstep: (lo, hi, v) => {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1e-9)));
    return t * t * (3 - 2 * t);
  },
};

const CONSTS: Record<string, number> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

const FUNC_ARITY: Record<string, number> = {
  pow: 2, min: 2, max: 2, atan2: 2, mod: 2, step: 2,
  clamp: 3, mix: 3, smoothstep: 3,
};

interface Token {
  type: 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (/[0-9.]/.test(ch)) {
      const match = src.slice(i).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/);
      if (!match) throw new Error(`Bad number at position ${i}`);
      tokens.push({ type: 'num', value: match[0] });
      i += match[0].length;
    } else if (/[a-zA-Z_]/.test(ch)) {
      const match = src.slice(i).match(/^[a-zA-Z_]\w*/)!;
      tokens.push({ type: 'ident', value: match[0] });
      i += match[0].length;
    } else if ('+-*/%^'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
    } else if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch });
      i += 1;
    } else if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch });
      i += 1;
    } else if (ch === ',') {
      tokens.push({ type: 'comma', value: ch });
      i += 1;
    } else {
      throw new Error(`Unexpected character "${ch}"`);
    }
  }
  return tokens;
}

/**
 * Compile an expression to a closure. Identifiers must be a whitelisted
 * function/constant or one of allowedVars — anything else is a parse error,
 * so model output can name nothing outside this sandbox.
 */
export function compileExpression(src: string, allowedVars: string[]): ExprFn {
  if (!src || !src.trim()) throw new Error('Empty expression');
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type: Token['type']) => {
    const token = next();
    if (!token || token.type !== type) {
      throw new Error(`Expected ${type}, got ${token ? `"${token.value}"` : 'end of input'}`);
    }
    return token;
  };

  function parsePrimary(): ExprFn {
    const token = next();
    if (!token) throw new Error('Unexpected end of expression');
    if (token.type === 'num') {
      const value = Number(token.value);
      return () => value;
    }
    if (token.type === 'op' && token.value === '-') {
      const operand = parsePrimary();
      return (vars) => -operand(vars);
    }
    if (token.type === 'op' && token.value === '+') {
      return parsePrimary();
    }
    if (token.type === 'lparen') {
      const inner = parseAdditive();
      expect('rparen');
      return inner;
    }
    if (token.type === 'ident') {
      const name = token.value;
      if (peek()?.type === 'lparen') {
        const fn = FUNCS[name];
        if (!fn) throw new Error(`Unknown function "${name}"`);
        next(); // consume (
        const args: ExprFn[] = [];
        if (peek()?.type !== 'rparen') {
          args.push(parseAdditive());
          while (peek()?.type === 'comma') {
            next();
            args.push(parseAdditive());
          }
        }
        expect('rparen');
        const arity = FUNC_ARITY[name] ?? 1;
        if (args.length !== arity) {
          throw new Error(`${name}() takes ${arity} argument${arity === 1 ? '' : 's'}`);
        }
        return (vars) => fn(...args.map((a) => a(vars)));
      }
      if (name in CONSTS) {
        const value = CONSTS[name];
        return () => value;
      }
      const lower = name.toLowerCase();
      if (lower in CONSTS) {
        const value = CONSTS[lower];
        return () => value;
      }
      if (allowedVars.includes(name)) {
        return (vars) => vars[name] ?? 0;
      }
      throw new Error(`Unknown identifier "${name}"`);
    }
    throw new Error(`Unexpected token "${token.value}"`);
  }

  function parsePower(): ExprFn {
    const base = parsePrimary();
    if (peek()?.type === 'op' && peek().value === '^') {
      next();
      const exponent = parsePower(); // right-associative
      return (vars) => Math.pow(base(vars), exponent(vars));
    }
    return base;
  }

  function parseMultiplicative(): ExprFn {
    let left = parsePower();
    while (peek()?.type === 'op' && '*/%'.includes(peek().value)) {
      const op = next().value;
      const right = parsePower();
      const lhs = left;
      if (op === '*') left = (vars) => lhs(vars) * right(vars);
      else if (op === '/') left = (vars) => {
        const d = right(vars);
        return d === 0 ? 0 : lhs(vars) / d;
      };
      else left = (vars) => FUNCS.mod(lhs(vars), right(vars));
    }
    return left;
  }

  function parseAdditive(): ExprFn {
    let left = parseMultiplicative();
    while (peek()?.type === 'op' && '+-'.includes(peek().value)) {
      const op = next().value;
      const right = parseMultiplicative();
      const lhs = left;
      left = op === '+' ? (vars) => lhs(vars) + right(vars) : (vars) => lhs(vars) - right(vars);
    }
    return left;
  }

  const root = parseAdditive();
  if (pos !== tokens.length) {
    throw new Error(`Unexpected trailing input "${tokens[pos].value}"`);
  }
  // NaN/Infinity must never reach vertex buffers
  return (vars) => {
    const v = root(vars);
    return Number.isFinite(v) ? v : 0;
  };
}
