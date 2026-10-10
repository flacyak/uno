// Package notation turns the markdown a math cell stores into the text it
// shows: x^2 in, x² out.
//
// `supported` names the first symbol outside the subset, so the editor can
// refuse a cell when it is authored. Rendering happens once at authoring
// time; the grid draws the result as plain text.

import { formatU, quote, runes } from "../go/index.ts";
import { NO_GLYPH, SUBSCRIPTS, SUPERSCRIPTS, SYMBOLS } from "./tables.ts";

export { NO_GLYPH, SUBSCRIPTS, SUPERSCRIPTS, SYMBOLS } from "./tables.ts";

/**
 * FRAC_SLASH renders \frac{a}{b} as a⁄b on one line. It is the only output
 * character defined here; the rest come from the tables.
 */
const FRAC_SLASH = "⁄";

/**
 * render transliterates the supported subset and always returns text. A
 * piece outside the subset is copied through verbatim.
 */
export function render(src: string): string {
  const s = new Scanner(runes(src));
  s.run();
  return s.out;
}

/**
 * supported returns an Error naming the first symbol outside the subset, or
 * undefined when the subset draws everything.
 */
export function supported(src: string): Error | undefined {
  const s = new Scanner(runes(src));
  s.run();
  return s.err;
}

/**
 * Scanner walks the source once, building the rendered text and keeping the
 * first error. One walk serves both `render` and `supported`.
 */
class Scanner {
  out = "";
  err: Error | undefined;
  private i = 0;

  constructor(private readonly src: string[]) {}

  run(): void {
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === "\\") this.command();
      else if (c === "^") this.script(SUPERSCRIPTS, "superscript");
      else if (c === "_") this.script(SUBSCRIPTS, "subscript");
      else {
        this.out += c;
        this.i++;
      }
    }
  }

  /** command reads a backslash name and whatever groups it takes. */
  private command(): void {
    const start = this.i;
    this.i++; // the backslash
    const name = word(this.src.slice(this.i));
    this.i += name.length;

    if (name === "") {
      return this.bail("a lone \\ names no symbol", start);
    }

    if (name === "frac") {
      const num = this.group();
      const den = this.group();
      if (num === undefined || den === undefined) {
        return this.bail("\\frac needs two {…} groups to draw", start);
      }
      this.out += this.nested(num) + FRAC_SLASH + this.nested(den);
      return;
    }

    const sym = SYMBOLS.get(name);
    if (sym !== undefined) {
      this.out += sym;
      return;
    }

    // The message names the code point in place of the character: the dialog
    // uses the same font and would show an empty box. Command names are
    // interpolated plainly, so \sum reads as typed.
    const missing = NO_GLYPH.get(name);
    if (missing !== undefined) {
      return this.bail(
        `\\${name} is ${formatU(missing)}, which uno's font has no glyph for`,
        start,
      );
    }

    this.bail(`\\${name} is not a symbol uno can draw`, start);
  }

  /**
   * script raises or lowers what follows a ^ or a _, bare (x^2) or braced
   * (e^{x}). Every character of the group needs a small form, or none of it
   * is drawn.
   */
  private script(table: Map<string, string>, kind: string): void {
    const start = this.i;
    const mark = this.src[this.i]!;
    this.i++; // the ^ or the _

    let content = this.group();
    if (content === undefined && this.i < this.src.length) {
      content = this.src.slice(this.i, this.i + 1);
      this.i++;
    }
    if (content === undefined || content.length === 0) {
      return this.bail(`${quote(mark)} needs a symbol after it`, start);
    }

    let small = "";
    for (let i = 0; i < content.length; i++) {
      const r = content[i]!;
      if (r === "\\") {
        // \alpha^{\beta}: name the whole command.
        return this.bail(`\\${word(content.slice(i + 1))} has no ${kind} form to draw`, start);
      }
      const c = table.get(r);
      if (c === undefined) {
        return this.bail(`${quote(r)} has no ${kind} form to draw`, start);
      }
      small += c;
    }
    this.out += small;
  }

  /**
   * group takes a balanced {…} at the cursor and returns its contents.
   * Otherwise it returns undefined and leaves the cursor where it was.
   * Nesting is counted.
   */
  private group(): string[] | undefined {
    if (this.i >= this.src.length || this.src[this.i] !== "{") return undefined;

    let depth = 0;
    for (let j = this.i; j < this.src.length; j++) {
      if (this.src[j] === "{") depth++;
      else if (this.src[j] === "}") {
        depth--;
        if (depth === 0) {
          const inner = this.src.slice(this.i + 1, j);
          this.i = j + 1;
          return inner;
        }
      }
    }
    return undefined; // the brace is unclosed
  }

  /**
   * nested renders the inside of a group and folds its first error into this
   * scanner's.
   */
  private nested(inner: string[]): string {
    const n = new Scanner(inner);
    n.run();
    this.failErr(n.err);
    return n.out;
  }

  /** literal copies the source from `start` to the cursor through unrendered. */
  private literal(start: number): void {
    this.out += this.src.slice(start, this.i).join("");
  }

  private fail(message: string): void {
    this.failErr(new Error(message));
  }

  /** bail records the error and copies the text from `start` through as typed. */
  private bail(message: string, start: number): void {
    this.fail(message);
    this.literal(start);
  }

  private failErr(err: Error | undefined): void {
    if (this.err === undefined && err !== undefined) this.err = err;
  }
}

/** word reads a command name: ASCII letters only. */
function word(rs: string[]): string {
  let n = 0;
  while (n < rs.length && /^[A-Za-z]$/.test(rs[n]!)) n++;
  return rs.slice(0, n).join("");
}
