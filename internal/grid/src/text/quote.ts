// Quoting text the way program notation and error messages spell it.

import { codePoint, runes } from './runes.ts';

// Printable: categories L, M, N, P and S, plus the ASCII space. `quote`
// leaves these unescaped.
const PRINTABLE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u;

const BEL = '\u0007'; // spelled \a, as C does

const SHORT_ESCAPES = new Map<string, string>([
  [BEL, '\\a'],
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
  ['\v', '\\v'],
  ['\\', '\\\\'],
  ['"', '\\"'],
]);

/**
 * quote wraps `s` in double quotes, escaping what is not printable with the
 * short escapes above or \x, \u and \U. `JSON.stringify` escapes a different
 * set and spells the escapes differently.
 */
export function quote(s: string): string {
  let out = '"';
  for (const r of s) {
    const short = SHORT_ESCAPES.get(r);
    if (short !== undefined) {
      out += short;
      continue;
    }
    if (r === ' ' || PRINTABLE.test(r)) {
      out += r;
      continue;
    }
    const cp = codePoint(r);
    if (cp < 0x100) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp < 0x10000) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += '\\U' + cp.toString(16).padStart(8, '0');
  }
  return out + '"';
}

const UNESCAPE = new Map<string, string>([
  ['a', BEL],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
]);

const HEX_WIDTHS: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * unquote reads a double-quoted literal as `quote` writes it, octal escapes
 * included. Throws "invalid syntax" on bad input.
 */
export function unquote(s: string): string {
  const r = runes(s);
  if (r.length < 2 || r[0] !== '"' || r[r.length - 1] !== '"') {
    throw new Error('invalid syntax');
  }

  let out = '';
  for (let i = 1; i < r.length - 1; i++) {
    const c = r[i];
    if (c === '"') throw new Error('invalid syntax');
    if (c !== '\\') {
      out += c;
      continue;
    }

    i++;
    if (i >= r.length - 1) throw new Error('invalid syntax');
    const k = r[i];

    const simple = UNESCAPE.get(k);
    if (simple !== undefined) {
      out += simple;
      continue;
    }

    const width = HEX_WIDTHS[k];
    if (width !== undefined) {
      const hex = r.slice(i + 1, i + 1 + width).join('');
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error('invalid syntax');
      }
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff) throw new Error('invalid syntax');
      // \x names a byte, the others name a code point.
      out += k === 'x' ? String.fromCharCode(cp) : String.fromCodePoint(cp);
      i += width;
      continue;
    }

    if (k >= '0' && k <= '7') {
      const oct = r.slice(i, i + 3).join('');
      if (!/^[0-7]{3}$/.test(oct)) throw new Error('invalid syntax');
      out += String.fromCharCode(parseInt(oct, 8));
      i += 2;
      continue;
    }

    throw new Error('invalid syntax');
  }
  return out;
}
