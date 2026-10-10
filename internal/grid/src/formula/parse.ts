import {
  Scanner,
  isDigit,
  isLetter,
  parseFloat as parseDecimal,
  quote,
  runes,
} from "../go/index.ts";
import type { Binary, Node } from "./ast.ts";
import { Formula } from "./ast.ts";

/**
 * parse reads the text form into a Formula. It throws on any syntax error:
 * an unclosed bracket, a bad name, a dangling operator, or unread text at
 * the end.
 */
export function parse(src: string): Formula {
  const p = new Parser(runes(src));
  return new Formula(p.whole(src, () => p.expr(0)));
}

/**
 * precedence is 1 for + and -, 2 for * and /, and 0 for anything else. 0
 * ends the expression loop.
 */
function precedence(r: string): number {
  if (r === "+" || r === "-") return 1;
  if (r === "*" || r === "/") return 2;
  return 0;
}

function isIdentStart(r: string): boolean {
  return isLetter(r) || r === "_";
}

function isIdentRune(r: string): boolean {
  return isIdentStart(r) || isDigit(r);
}

/**
 * Parser is a scanner over the text form. Lexing happens inline, straight
 * from the runes.
 */
class Parser extends Scanner {
  constructor(s: string[]) {
    super(s, "formula");
  }

  /**
   * expr parses by precedence climbing: it reads a term, then takes
   * operators with precedence at least `min`, parsing each right-hand side
   * at `prec + 1`. That makes every operator left-associative.
   */
  expr(min: number): Node {
    let left = this.term();
    for (;;) {
      this.space();
      if (this.i >= this.s.length) return left;

      const op = this.s[this.i]!;
      const prec = precedence(op);
      if (prec === 0 || prec < min) return left;

      this.i++;
      const right = this.expr(prec + 1);
      left = { kind: "binary", op: op as Binary["op"], left, right };
    }
  }

  /**
   * term reads one operand with any leading minuses: a bracketed
   * expression, a number or a column name. A minus binds tighter than every
   * binary operator.
   */
  private term(): Node {
    if (this.accept("-")) {
      return { kind: "unary", operand: this.term() };
    }

    this.space();
    const c = this.s[this.i];
    if (c === "(") {
      this.i++;
      const inner = this.expr(0);
      this.expect(")");
      return { kind: "group", inner };
    }
    if (c !== undefined && isDigit(c)) return this.number();
    if (c !== undefined && isIdentStart(c)) return { kind: "col", name: this.ident() };

    throw new Error(
      `expected a number, a column name or ( at character ${this.i + 1}, ${this.here()}`,
    );
  }

  /**
   * number reads a decimal literal: digits with an optional fraction, and
   * that form only.
   */
  private number(): Node {
    const start = this.i;
    while (this.i < this.s.length && isDigit(this.s[this.i]!)) this.i++;

    if (this.i < this.s.length && this.s[this.i] === ".") {
      this.i++;
      if (this.i >= this.s.length || !isDigit(this.s[this.i]!)) {
        throw new Error(
          `expected a digit after the full stop at character ${this.i + 1}, ${this.here()}`,
        );
      }
      while (this.i < this.s.length && isDigit(this.s[this.i]!)) this.i++;
    }

    const text = this.s.slice(start, this.i).join("");
    const value = parseDecimal(text);
    if (value === undefined) {
      throw new Error(`number ${quote(text)} at character ${start + 1}: invalid syntax`);
    }
    return { kind: "num", text, value };
  }

  /**
   * ident reads a column name: letters, digits and underscores. Letter is
   * Unicode's letter, so a header like région is accepted.
   */
  private ident(): string {
    const start = this.i;
    while (this.i < this.s.length && isIdentRune(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i).join("");
  }
}
