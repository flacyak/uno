import { indexOfRunes, quote, quoteMeta, runes } from "../go/index.ts";
import { MAX_PARTS } from "../program/index.ts";
import { MAX_DIFF } from "./align.ts";
import { MAX_PER_EXAMPLE } from "./induce.ts";

/**
 * minPiece is the shortest run of characters taken as a piece of the old value
 * rather than as a constant. One character that happens to appear in both is a
 * coincidence; two are a quotation.
 */
const MIN_PIECE = 2;

/**
 * restructures induces the programs that move characters rather than change
 * them: pulling a code out of the middle of a cell, or putting two fields back
 * in the other order.
 *
 * It runs only when no rewrite fits, because the two readings of an edit are
 * different intents. Stripping the separators from 1,204 and slicing four
 * characters out of it agree on that row and on nothing after it.
 */
export function restructures(was: string, now: string): string[] {
  const a = runes(was);
  const b = runes(now);
  if (a.length > MAX_DIFF || b.length > MAX_DIFF || was === now || b.length === 0) return [];

  const parts = decompose(a, b);
  if (parts === undefined || parts.length === 0 || parts.length > MAX_PARTS) return [];

  // A decomposition that quotes nothing describes setting the column to a
  // constant, which is a thing to type rather than a thing to infer.
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
    // A lone slice is a step, not a concat of one.
    out.push(c.length === 1 ? c[0]! : "concat(" + c.join(", ") + ")");
  }
  return out;
}

/** One stretch of the new value: either a constant the person typed, or a
 * quotation from the old value. */
interface Piece {
  lit: string;
  from: number;
  to: number;
  isSlice: boolean;
}

/**
 * decompose reads the new value as a sequence of quotations from the old one
 * with constants between them.
 *
 * It is greedy from the left, taking the longest quotation available at each
 * point, which is what makes the same reading come back for the same pair of
 * values every time.
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

/** longestQuote finds the longest prefix of rest that appears in a, and where. */
function longestQuote(a: string[], rest: string[]): [number, number] {
  const limit = Math.min(rest.length, a.length);
  for (let n = limit; n >= MIN_PIECE; n--) {
    const i = indexOfRunes(a.join(""), rest.slice(0, n).join(""));
    if (i >= 0) return [i, n];
  }
  return [0, 0];
}

/**
 * sliceSrcs is the lattice for one quotation: where its two ends could be said
 * to be.
 *
 * A character count holds only for rows shaped exactly like this one, so each
 * end also gets a description in terms of the delimiter beside it, which is the
 * form that survives a row of a different length.
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
 * boundary describes a position by the character sitting at it: the k-th comma,
 * counted from the front and from the back.
 *
 * Both, because "after the first comma" and "after the last comma" are
 * different intents that agree on a value holding one comma, and only more
 * examples can tell them apart.
 */
function boundary(a: string[], at: number, side: string): string[] {
  const target = a[at]!;
  const c = quoteMeta(target);

  let k = 0;
  for (const r of a.slice(0, at + 1)) if (r === target) k++;
  let total = k;
  for (const r of a.slice(at + 1)) if (r === target) total++;

  return [
    side + "(/" + c + "/, " + String(k) + ")",
    side + "(/" + c + "/, " + String(k - total - 1) + ")",
  ];
}

/** cross enumerates one choice per part, stopping at the same bound every other
 * generator here respects. */
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
