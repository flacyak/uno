import { Scanner, atoi, isDigit, isLetter, quote, runes, unquote } from "../go/index.ts";
import type { Pos, Step } from "./steps.ts";
import { MAX_PARTS, MAX_STEPS, compilePattern, newReplace } from "./steps.ts";
import type { Program } from "./program.ts";

/**
 * parse reads the text form into a Program. Patterns are compiled here, so a
 * bad pattern fails at parse time.
 */
export function parse(src: string): Program {
  const p = new Parser(runes(src));
  const out = p.whole(src, () => {
    const steps: Step[] = [];
    do steps.push(p.step());
    while (p.accept("|"));
    return steps;
  });
  if (out.length > MAX_STEPS) {
    p.refuse(src, `${out.length} steps, and the limit is ${MAX_STEPS}`);
  }
  return out;
}

/** What each step reads between its brackets. */
const ARGS: Record<string, (p: Parser) => Step> = {
  replace: (p) => p.replaceArgs(),
  slice: (p) => p.sliceArgs(),
  concat: (p) => p.concatArgs(),
  trim: () => ({ kind: "trim" }),
  upper: () => ({ kind: "case", up: true }),
  lower: () => ({ kind: "case", up: false }),
};

/** Parser is a Scanner over the text form: a step name, then its arguments. */
class Parser extends Scanner {
  constructor(s: string[]) {
    super(s, "program");
  }

  private ident(): string {
    this.space();
    const start = this.i;
    while (this.i < this.s.length && isLetter(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i).join("");
  }

  step(): Step {
    this.space();
    const at = this.i + 1;
    const name = this.ident();
    if (name === "") {
      throw new Error(`expected a step name at character ${at}, ${this.here()}`);
    }
    this.expect("(");
    // Own keys only: "constructor" is letters, and a prototype key.
    if (!Object.hasOwn(ARGS, name))
      throw new Error(`unknown step ${quote(name)} at character ${at}`);
    const st = ARGS[name]!(this);
    this.expect(")");
    return st;
  }

  replaceArgs(): Step {
    const re = this.regexArg();
    this.expect(",");
    const lit = this.stringArg();
    return newReplace(re, lit);
  }

  sliceArgs(): Step {
    const from = this.pos();
    this.expect(",");
    const to = this.pos();
    return { kind: "slice", from, to };
  }

  /**
   * concatArgs reads the parts of a concat. Fewer than two parts, or more
   * than MAX_PARTS, is refused.
   */
  concatArgs(): Step {
    const parts: Step[] = [];
    for (;;) {
      this.space();
      if (this.i < this.s.length && this.s[this.i] === '"') {
        parts.push({ kind: "const", lit: this.stringArg() });
      } else {
        if (this.ident() !== "slice") {
          throw new Error(
            `expected a "string" or slice( at character ${this.i + 1}, ${this.here()}`,
          );
        }
        this.expect("(");
        const st = this.sliceArgs();
        this.expect(")");
        parts.push(st);
      }
      if (!this.accept(",")) break;
    }

    if (parts.length < 2) {
      throw new Error(`concat of ${parts.length} part: a concat needs at least two`);
    }
    if (parts.length > MAX_PARTS) {
      throw new Error(`concat of ${parts.length} parts, and the limit is ${MAX_PARTS}`);
    }
    return { kind: "concat", parts };
  }

  private pos(): Pos {
    this.space();
    if (this.i < this.s.length && (this.s[this.i] === "-" || isDigit(this.s[this.i]!))) {
      return { kind: "idx", k: this.intArg() };
    }

    const name = this.ident();
    if (name === "len") return { kind: "len" };
    if (name !== "start" && name !== "end") {
      throw new Error(
        `expected a character index, len, start( or end( at character ${this.i + 1}, ${this.here()}`,
      );
    }

    this.expect("(");
    const re = this.regexArg();
    this.expect(",");
    const k = this.intArg();
    if (k === 0) {
      throw new Error(`match number 0 at character ${this.i}: matches are counted from 1`);
    }

    const p: Pos = { kind: "match", re: compilePattern(re), src: re, k, atEnd: name === "end" };
    this.expect(")");
    return p;
  }

  /**
   * regexArg reads /.../ and unescapes only `\/`. Every other escape is
   * passed to the engine as written.
   */
  private regexArg(): string {
    this.space();
    if (this.i >= this.s.length || this.s[this.i] !== "/") {
      throw new Error(`expected a /pattern/ at character ${this.i + 1}, ${this.here()}`);
    }
    this.i++;

    let out = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === "\\" && this.i + 1 < this.s.length) {
        out += this.s[this.i + 1] === "/" ? "/" : "\\" + this.s[this.i + 1]!;
        this.i += 2;
      } else if (c === "/") {
        this.i++;
        return out;
      } else {
        out += c;
        this.i++;
      }
    }
    throw new Error("a /pattern/ was opened and never closed");
  }

  private stringArg(): string {
    this.space();
    if (this.i >= this.s.length || this.s[this.i] !== '"') {
      throw new Error(`expected a "string" at character ${this.i + 1}, ${this.here()}`);
    }

    // Scanned to the closing quote, then read by `unquote`, so the escape
    // rules are Go's.
    for (let j = this.i + 1; j < this.s.length; j++) {
      if (this.s[j] === "\\") {
        j++;
        continue;
      }
      if (this.s[j] === '"') {
        let v: string;
        try {
          v = unquote(this.s.slice(this.i, j + 1).join(""));
        } catch (err) {
          throw new Error(`string at character ${this.i + 1}: ${(err as Error).message}`);
        }
        this.i = j + 1;
        return v;
      }
    }
    throw new Error('a "string" was opened and never closed');
  }

  private intArg(): number {
    this.space();
    const start = this.i;
    if (this.i < this.s.length && this.s[this.i] === "-") this.i++;
    while (this.i < this.s.length && isDigit(this.s[this.i]!)) this.i++;

    const n = atoi(this.s.slice(start, this.i).join(""));
    if (n === undefined) {
      throw new Error(`expected a number at character ${start + 1}, ${this.here()}`);
    }
    return n;
  }
}
