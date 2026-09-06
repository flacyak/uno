import {
  isDigit,
  isLetter,
  isSpace,
  parseFloat as parseDecimal,
  quote,
  runes,
} from "../go/index.ts";
import type { Binary, Node } from "./ast.ts";
import { Formula } from "./ast.ts";

/**
 * parse reads the text form.
 *
 * Everything an expression can be wrong about is decided here rather than at
 * evaluation: an unclosed bracket, a name that is not a name, an operator with
 * nothing to its right. A binding that survives parse fails per row or not at
 * all, which is what lets the editor preview row one and mean it.
 *
 * It throws where Go returns an error. Callers wrap the message the way the Go
 * ones wrap the error, so what reaches a person is unchanged.
 */
export function parse(src: string): Formula {
  const p = new Parser(runes(src));

  let root: Node;
  try {
    root = p.expr(0);
  } catch (err) {
    throw new Error(`formula ${quote(src)}: ${(err as Error).message}`);
  }

  p.space();
  if (p.i < p.s.length) {
    throw new Error(
      `formula ${quote(src)}: unexpected ${quote(p.s[p.i]!)} at character ${p.i + 1}`,
    );
  }
  return new Formula(root);
}

/**
 * precedence orders the four operators and nothing else. Reporting 0 for
 * anything that is not one is how the expression loop knows it has reached the
 * end of what it is allowed to eat.
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
 * Parser is a scanner over the text form. It is hand-written because the
 * grammar is four operators and three kinds of term.
 *
 * Lexing happens inside the parser rather than ahead of it. There are no
 * keywords and no lookahead past one character, so a token list would be a
 * second representation of the same string, and the character offsets an error
 * points at would have to be carried through it.
 */
class Parser {
  i = 0;

  constructor(readonly s: string[]) {}

  space(): void {
    while (this.i < this.s.length && isSpace(this.s[this.i]!)) this.i++;
  }

  private accept(r: string): boolean {
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
    if (this.i >= this.s.length) return "and the formula ends there";
    const ahead = this.s.slice(this.i, Math.min(this.i + 8, this.s.length)).join("");
    return `found ${quote(ahead)}`;
  }

  /**
   * expr climbs precedence: it reads a term, then keeps taking operators at
   * least as binding as min and recursing one level tighter for their
   * right-hand side.
   *
   * Recursing at prec+1 is what makes every operator left-associative, so
   * `a - b - c` groups the way arithmetic reads it rather than the way the
   * recursion falls out.
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
   * term reads one operand, including any leading minuses. A minus binds
   * tighter than every binary operator, so -a * b is (-a) * b -- which is the
   * same number either way for these four operators, and the reading a person
   * expects.
   */
  private term(): Node {
    if (this.accept("-")) {
      return { kind: "unary", operand: this.term() };
    }

    this.space();
    if (this.i >= this.s.length) {
      throw new Error(
        `expected a number, a column name or ( at character ${this.i + 1}, ${this.here()}`,
      );
    }

    const c = this.s[this.i]!;
    if (c === "(") {
      this.i++;
      const inner = this.expr(0);
      this.expect(")");
      return { kind: "group", inner };
    }
    if (isDigit(c)) return this.number();
    if (isIdentStart(c)) return { kind: "col", name: this.ident() };

    throw new Error(
      `expected a number, a column name or ( at character ${this.i + 1}, ${this.here()}`,
    );
  }

  /**
   * number reads a decimal literal, and only a decimal one. It refuses the
   * exponent, hexadecimal and infinity forms a general parser would otherwise
   * accept, for the reason `num.isNumber` does: none of them is a thing a
   * person writes into a spreadsheet, and each is a thing a typo can be read as.
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
   * ident reads a column name. Letters, digits and underscores, never starting
   * with a digit, because a name that starts with a digit could not be told
   * from the number beside it.
   *
   * Letter is Unicode's letter rather than an ASCII range: a header is as
   * likely to be région as it is to be region, and a build that could not
   * reference it would be refusing the data it was given.
   */
  private ident(): string {
    const start = this.i;
    while (this.i < this.s.length && isIdentRune(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i).join("");
  }
}
