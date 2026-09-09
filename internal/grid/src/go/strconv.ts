// Go's strconv, where JavaScript's number and string literals differ.

import { runes } from "./strings.ts";

/**
 * formatFloat is `strconv.FormatFloat(v, 'f', -1, 64)`: the shortest decimal
 * that reads back as the same float64, in plain notation, never exponential.
 *
 * `Number.prototype.toString` gets the shortest part right and the notation
 * wrong -- it switches to exponential above 1e21 and below 1e-6, and a
 * spreadsheet column showing 1.234567890e+12 has helped nobody.
 */
export function formatFloat(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  // Go prints the sign of a negative zero; JavaScript drops it.
  if (Object.is(v, -0)) return "-0";

  const s = v.toString();
  const e = s.indexOf("e");
  if (e < 0) return s;

  const exp = Number(s.slice(e + 1));
  let mantissa = s.slice(0, e);
  let sign = "";
  if (mantissa.startsWith("-")) {
    sign = "-";
    mantissa = mantissa.slice(1);
  }

  const dot = mantissa.indexOf(".");
  let digits = mantissa;
  let point = mantissa.length;
  if (dot >= 0) {
    digits = mantissa.slice(0, dot) + mantissa.slice(dot + 1);
    point = dot;
  }
  point += exp;

  if (point <= 0) return sign + "0." + "0".repeat(-point) + digits;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return sign + digits.slice(0, point) + "." + digits.slice(point);
}

/**
 * roundSignificant is the round trip through `strconv.FormatFloat(v, 'g', n, 64)`
 * and back: keep n significant digits, then read the result as a float again.
 *
 * It is what turns 0.21999999999999997 into 0.22 -- far more precision than a
 * cell displays, and far less than float64 noise.
 */
export function roundSignificant(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v;
  return Number(v.toPrecision(digits));
}

// strconv.IsPrint: categories L, M, N, P and S, plus the ASCII space. Go's
// Quote leaves these alone, so an accented letter in a cell stays legible in an
// error message instead of becoming an escape.
const PRINTABLE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u;

const BEL = "\u0007"; // Go spells this \a

const SHORT_ESCAPES = new Map<string, string>([
  [BEL, "\\a"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\v", "\\v"],
  ["\\", "\\\\"],
  ['"', '\\"'],
]);

/**
 * quote is `strconv.Quote`, which is what every `%q` in the Go core prints and
 * what the transform language's text form round-trips through.
 *
 * `JSON.stringify` is close and not the same: it escapes a different set and
 * spells the escapes differently.
 */
export function quote(s: string): string {
  let out = '"';
  for (const r of s) {
    const short = SHORT_ESCAPES.get(r);
    if (short !== undefined) {
      out += short;
      continue;
    }
    if (r === " " || PRINTABLE.test(r)) {
      out += r;
      continue;
    }
    const cp = r.codePointAt(0)!;
    if (cp < 0x100) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x10000) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += "\\U" + cp.toString(16).padStart(8, "0");
  }
  return out + '"';
}

const UNESCAPE = new Map<string, string>([
  ["a", BEL],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
]);

const HEX_WIDTHS: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * unquote is `strconv.Unquote` for a double-quoted literal, which is the only
 * form the transform language's parser hands it.
 *
 * It throws rather than returning an error pair, because its one caller wraps
 * the failure in a message naming the character the string started at.
 */
export function unquote(s: string): string {
  const r = runes(s);
  if (r.length < 2 || r[0] !== '"' || r[r.length - 1] !== '"') {
    throw new Error("invalid syntax");
  }

  let out = "";
  for (let i = 1; i < r.length - 1; i++) {
    const c = r[i]!;
    if (c === '"') throw new Error("invalid syntax");
    if (c !== "\\") {
      out += c;
      continue;
    }

    i++;
    if (i >= r.length - 1) throw new Error("invalid syntax");
    const k = r[i]!;

    const simple = UNESCAPE.get(k);
    if (simple !== undefined) {
      out += simple;
      continue;
    }

    const width = HEX_WIDTHS[k];
    if (width !== undefined) {
      const hex = r.slice(i + 1, i + 1 + width).join("");
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error("invalid syntax");
      }
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff) throw new Error("invalid syntax");
      // \x names a byte in Go, the others name a code point.
      out += k === "x" ? String.fromCharCode(cp) : String.fromCodePoint(cp);
      i += width;
      continue;
    }

    if (k >= "0" && k <= "7") {
      const oct = r.slice(i, i + 3).join("");
      if (!/^[0-7]{3}$/.test(oct)) throw new Error("invalid syntax");
      out += String.fromCharCode(parseInt(oct, 8));
      i += 2;
      continue;
    }

    throw new Error("invalid syntax");
  }
  return out;
}

// What `strconv.ParseFloat` will read, once num's character whitelist has
// already refused the hexadecimal and infinity spellings Go also accepts.
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * parseFloat is `strconv.ParseFloat(v, 64)` narrowed to decimal input.
 *
 * `Number()` is not it: `Number("")` is 0, `Number("0x10")` is 16, and
 * `Number(" 12 ")` is 12, all of which have to be refusals here.
 */
export function parseFloat(v: string): number | undefined {
  if (!DECIMAL.test(v)) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * atoi is `strconv.Atoi`: a whole decimal integer and nothing else. The
 * transform language's parser uses it for slice positions and match counts.
 */
export function atoi(s: string): number | undefined {
  if (!/^[+-]?\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}
