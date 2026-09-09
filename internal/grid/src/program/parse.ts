import { atoi, compile, isDigit, isLetter, isSpace, quote, runes, unquote } from "../go/index.ts";
import type { Pos, Step } from "./steps.ts";
import { MAX_PARTS, MAX_STEPS, newReplace } from "./steps.ts";
import type { Program } from "./program.ts";

/**
 * parse reads the text form.
 *
 * Patterns compile here rather than at apply time, so a damaged log fails at
 * replay with the line that broke it instead of halfway through rewriting a
 * column.
 */
export function parse(src: string): Program {
  const p = new Parser(runes(src));

  const out: Step[] = [];
  for (;;) {
    try {
      out.push(p.step());
    } catch (err) {
      throw new Error(`program ${quote(src)}: ${(err as Error).message}`);
    }
    p.space();
    if (!p.accept("|")) break;
  }

  p.space();
  if (p.i < p.s.length) {
    throw new Error(
      `program ${quote(src)}: unexpected ${quote(p.s[p.i]!)} at character ${p.i + 1}`,
    );
  }
  if (out.length > MAX_STEPS) {
    throw new Error(`program ${quote(src)}: ${out.length} steps, and the limit is ${MAX_STEPS}`);
  }
  return out;
}

/**
 * Parser is a scanner over the text form. It is hand-written because the
 * grammar is five step names deep and a generated parser would be a build step
 * and a dependency for something smaller than the file describing it.
 */
class Parser {
  i = 0;

  constructor(readonly s: string[]) {}

  space(): void {
    while (this.i < this.s.length && isSpace(this.s[this.i]!)) this.i++;
  }

  accept(r: string): boolean {
    this.space();
    if (this.i < this.s.length && this.s[this.i] === r) {
      this.i++;
      return true;
    }
    return false;
  }

  private expect(r: string): void {
    if (this.accept(r)) return;
    throw new Error(`expected ${quote(r)} at character ${this.i + 1}, ${this.here()}`);
  }

  /** here names what was found instead, so an error points at the text rather
   * than only at an offset into it. */
  private here(): string {
    if (this.i >= this.s.length) return "and the program ends there";
    const ahead = this.s.slice(this.i, Math.min(this.i + 8, this.s.length)).join("");
    return `found ${quote(ahead)}`;
  }

  private ident(): string {
    this.space();
    const start = this.i;
    while (this.i < this.s.length && isLetter(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i).join("");
  }

  step(): Step {
    const name = this.ident();
    if (name === "") {
      throw new Error(`expected a step name at character ${this.i + 1}, ${this.here()}`);
    }
    this.expect("(");

    let st: Step;
    switch (name) {
      case "replace":
        st = this.replaceArgs();
        break;
      case "slice":
        st = this.sliceArgs();
        break;
      case "concat":
        st = this.concatArgs();
        break;
      case "trim":
        st = { kind: "trim" };
        break;
      case "upper":
        st = { kind: "case", up: true };
        break;
      case "lower":
        st = { kind: "case", up: false };
        break;
      default:
        throw new Error(`unknown step ${quote(name)} at character ${this.i - name.length}`);
    }

    this.expect(")");
    return st;
  }

  private replaceArgs(): Step {
    const re = this.regexArg();
    this.expect(",");
    const lit = this.stringArg();
    return newReplace(re, lit);
  }

  private sliceArgs(): Step {
    const from = this.pos();
    this.expect(",");
    const to = this.pos();
    return { kind: "slice", from, to };
  }

  /**
   * concatArgs reads the parts. A single part is refused: concat of one thing
   * is that thing, and two spellings of one program would both have to
   * round-trip.
   */
  private concatArgs(): Step {
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

    let compiled: RegExp;
    try {
      compiled = compile(re);
    } catch (err) {
      throw new Error(`pattern /${re}/: ${(err as Error).message}`);
    }
    const p: Pos = { kind: "match", re: compiled, src: re, k, atEnd: name === "end" };
    this.expect(")");
    return p;
  }

  /**
   * regexArg reads /.../ and unescapes only the delimiter. Everything else is
   * handed to the engine untouched, so \d in a program means what it means
   * everywhere else rather than what this parser decided it should.
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

    // `unquote` decides where the string ends, so the escape rules here are
    // Go's rather than a second set invented for this file.
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
