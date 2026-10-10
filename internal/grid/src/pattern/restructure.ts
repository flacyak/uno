import { indexOfRunes, quote, quoteMeta, runes } from "../go/index.ts";
import { MAX_PARTS, quoteRegex } from "../program/index.ts";
import { MAX_DIFF } from "./align.ts";
import { MAX_PER_EXAMPLE } from "./induce.ts";

/**
 * MIN_PIECE is the shortest run of the old value taken as a slice. Shorter
 * runs become typed constant text.
 */
const MIN_PIECE = 2;

/**
 * restructures induces the programs that move characters: slices of the old
 * value, joined with constants. The Survey runs it only when the rewrites come
 * up empty.
 */
export function restructures(was: string, now: string): string[] {
  const a = runes(was);
  const b = runes(now);
  if (a.length > MAX_DIFF || b.length > MAX_DIFF || was === now || b.length === 0) return [];

  const parts = decompose(a, b);
  if (parts === undefined || parts.length === 0 || parts.length > MAX_PARTS) return [];

  // A decomposition must hold a slice. Constants alone would set the column
  // to one value.
  let quoted = false;
  const sets: string[][] = [];
  for (const p of parts) {
    if (!p.isSlice) {
      sets.push([quote(p.lit)]);
      continue;
    }
    quoted = true;
    sets.push(sliceSrcs(a, p.from, p.to));
  }
  if (!quoted) return [];

  const out: string[] = [];
  for (const c of cross(sets)) {
    // A lone slice is a step of its own.
    out.push(c.length === 1 ? c[0]! : "concat(" + c.join(", ") + ")");
  }
  return out;
}

/** One stretch of the new value: a constant the person typed, or a slice of
 * the old value. */
interface Piece {
  lit: string;
  from: number;
  to: number;
  isSlice: boolean;
}

/**
 * decompose reads the new value as slices of the old value with constants
 * between them. It is greedy from the left, taking the longest slice at each
 * point. Returns undefined when there are more than MAX_PARTS parts.
 */
function decompose(a: string[], b: string[]): Piece[] | undefined {
  const parts: Piece[] = [];
  let lit = "";

  const flush = (): void => {
    if (lit.length > 0) {
      parts.push({ lit, from: 0, to: 0, isSlice: false });
      lit = "";
    }
  };

  for (let i = 0; i < b.length;) {
    const [at, n] = longestQuote(a, b.slice(i));
    if (n < MIN_PIECE) {
      lit += b[i]!;
      i++;
      continue;
    }
    flush();
    parts.push({ lit: "", from: at, to: at + n, isSlice: true });
    i += n;
    if (parts.length > MAX_PARTS) return undefined;
  }
  flush();
  return parts;
}

/** longestQuote finds the longest prefix of `rest` found in `a`, and where. */
function longestQuote(a: string[], rest: string[]): [number, number] {
  const limit = Math.min(rest.length, a.length);
  for (let n = limit; n >= MIN_PIECE; n--) {
    const i = indexOfRunes(a.join(""), rest.slice(0, n).join(""));
    if (i >= 0) return [i, n];
  }
  return [0, 0];
}

/**
 * sliceSrcs lists the ways to name each end of a slice: by index from the
 * front, by index from the back, and by the character beside it. Returns
 * every from/to pairing as slice(...) text.
 */
function sliceSrcs(a: string[], from: number, to: number): string[] {
  const froms = [String(from)];
  if (from > 0) {
    froms.push(String(from - a.length), ...boundary(a, from - 1, "end"));
  }

  const tos: string[] = [];
  if (to === a.length) {
    tos.push("len");
  } else {
    tos.push(String(to), String(to - a.length), ...boundary(a, to, "start"));
  }

  const out: string[] = [];
  for (const f of froms) {
    for (const t of tos) out.push("slice(" + f + ", " + t + ")");
  }
  return out;
}

/**
 * boundary names a position by the character at it: the k-th occurrence
 * counted from the front, and counted from the back.
 */
function boundary(a: string[], at: number, side: string): string[] {
  const target = a[at]!;
  // Through quoteRegex, so a `/` is escaped.
  const c = quoteRegex(quoteMeta(target));

  let k = 0;
  for (const r of a.slice(0, at + 1)) if (r === target) k++;
  let total = k;
  for (const r of a.slice(at + 1)) if (r === target) total++;

  return [
    side + "(" + c + ", " + String(k) + ")",
    side + "(" + c + ", " + String(k - total - 1) + ")",
  ];
}

/** cross enumerates one choice per part, stopping at MAX_PER_EXAMPLE results. */
function cross(sets: string[][]): string[][] {
  let out: string[][] = [[]];
  for (const set of sets) {
    const next: string[][] = [];
    for (const have of out) {
      for (const s of set) {
        if (next.length >= MAX_PER_EXAMPLE) return next;
        next.push([...have, s]);
      }
    }
    out = next;
  }
  return out;
}
