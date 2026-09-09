// Package notation turns the markdown a math cell stores into the text it
// shows: x^2 in, x² out.
//
// The whole design is about being honest that the subset is narrow: `supported`
// names the first symbol it cannot draw so the editor can refuse a cell at
// authoring time, rather than leaving a person to find a missing-glyph box in
// their sheet later.
//
// Rendering happens once, when the cell is authored, so what leaves here is
// finished text and the grid goes on drawing plain text. Putting the
// transliteration on the display path instead would mean parsing markdown for
// every visible cell on every scroll frame, including the plain ones.

import { formatU, quote, runes } from "../go/index.ts";
import { NO_GLYPH, SUBSCRIPTS, SUPERSCRIPTS, SYMBOLS } from "./tables.ts";

export { NO_GLYPH, SUBSCRIPTS, SUPERSCRIPTS, SYMBOLS } from "./tables.ts";

/**
 * FRAC_SLASH renders \frac{a}{b} as a⁄b, on one line.
 *
 * A real fraction is stacked, which a line of text cannot be, so this is an
 * approximation and is meant to read as one -- not a pretence that the subset
 * does fractions. It is the only character this module emits that comes from no
 * table.
 */
const FRAC_SLASH = "⁄";

/**
 * render transliterates the supported subset and never fails.
 *
 * A cell can only be saved once `supported` has accepted it, so the source
 * `render` meets has already been checked. When it meets something it cannot
 * draw anyway -- a .unof edited by hand, a subset narrowed by a later release --
 * it copies that piece through verbatim rather than dropping it. A cell showing
 * a backslash is recoverable; a cell that silently swallowed part of what
 * someone typed is not.
 */
export function render(src: string): string {
  const s = new Scanner(runes(src));
  s.run();
  return s.out;
}

/**
 * supported names the first symbol the subset cannot draw, or returns undefined.
 *
 * First rather than all of them: the editor is asking whether this cell can be
 * saved, and one named symbol is what a person can act on. The message always
 * names the symbol itself, because "unsupported notation" would send someone
 * hunting through their own expression for it.
 */
export function supported(src: string): Error | undefined {
  const s = new Scanner(runes(src));
  s.run();
  return s.err;
}

/**
 * Scanner walks the source once, building the rendered text and keeping the
 * first complaint.
 *
 * One walk serves both entry points so that what `supported` accepts is exactly
 * what `render` draws. Two separate passes would drift apart on the first table
 * somebody edited.
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
      this.fail("a lone \\ names no symbol");
      this.literal(start);
      return;
    }

    if (name === "frac") {
      const num = this.group();
      const den = this.group();
      if (num === undefined || den === undefined) {
        this.fail("\\frac needs two {…} groups to draw");
        this.literal(start);
        return;
      }
      this.out += this.nested(num) + FRAC_SLASH + this.nested(den);
      return;
    }

    const sym = SYMBOLS.get(name);
    if (sym !== undefined) {
      this.out += sym;
      return;
    }

    // The complaint names the codepoint and never prints the character: the
    // dialog carrying this message is drawn in the same font, so a message
    // about an empty box would contain one. Command names go through plain
    // interpolation rather than through `quote` for the same reason of reading
    // back what was typed -- quoting would show \\sum for the \sum a person put
    // in the cell.
    const missing = NO_GLYPH.get(name);
    if (missing !== undefined) {
      this.fail(`\\${name} is ${formatU(missing)}, which uno's font has no glyph for`);
      this.literal(start);
      return;
    }

    this.fail(`\\${name} is not a symbol uno can draw`);
    this.literal(start);
  }

  /**
   * script raises or lowers what follows a ^ or a _, in either the bare form
   * x^2 or the braced form e^{x}.
   *
   * Every character of the group has to have a small form or none of it is
   * drawn: half a raised exponent sitting next to a full-size character reads
   * as a different expression from the one that was typed.
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
      this.fail(`${quote(mark)} needs a symbol after it`);
      this.literal(start);
      return;
    }

    let small = "";
    for (let i = 0; i < content.length; i++) {
      const r = content[i]!;
      if (r === "\\") {
        // \alpha^{\beta}. Naming the command is more use to a person than
        // naming the backslash it happens to begin with.
        this.fail(`\\${word(content.slice(i + 1))} has no ${kind} form to draw`);
        this.literal(start);
        return;
      }
      const c = table.get(r);
      if (c === undefined) {
        this.fail(`${quote(r)} has no ${kind} form to draw`);
        this.literal(start);
        return;
      }
      small += c;
    }
    this.out += small;
  }

  /**
   * group takes a balanced {…} at the cursor and returns what is inside it,
   * leaving the cursor untouched when there is no group to take. It counts
   * depth so that \frac{1}{\frac{a}{b}} finds the closing brace that belongs
   * to it.
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
    return undefined; // unclosed, so there is no group here
  }

  /**
   * nested renders the inside of a group, folding its first complaint into this
   * scanner's so that the symbol `supported` names is the first one in the
   * source and not the first one at the outermost level.
   */
  private nested(inner: string[]): string {
    const n = new Scanner(inner);
    n.run();
    this.failErr(n.err);
    return n.out;
  }

  /**
   * literal copies the source from start to the cursor through unrendered. See
   * `render` on why an unsupported piece survives rather than vanishing.
   */
  private literal(start: number): void {
    this.out += this.src.slice(start, this.i).join("");
  }

  private fail(message: string): void {
    this.failErr(new Error(message));
  }

  private failErr(err: Error | undefined): void {
    if (this.err === undefined && err !== undefined) this.err = err;
  }
}

/**
 * word reads a command name: ASCII letters only, which is every name the subset
 * has and stops \alpha+\beta at the plus.
 */
function word(rs: string[]): string {
  let n = 0;
  while (n < rs.length && /^[A-Za-z]$/.test(rs[n]!)) n++;
  return rs.slice(0, n).join("");
}
