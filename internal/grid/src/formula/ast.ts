// The expression tree: a discriminated union of five node kinds.

import { compareStrings } from "../go/index.ts";

/**
 * NumLit is a number literal. `text` is how it was written and `value` is
 * what it parsed to.
 */
export interface NumLit {
  readonly kind: "num";
  readonly text: string;
  readonly value: number;
}

/**
 * ColRef names a column by its header. The header has to be a valid
 * identifier: letters, digits and underscores, starting with a letter or an
 * underscore.
 */
export interface ColRef {
  readonly kind: "col";
  readonly name: string;
}

/**
 * Binary is one of the four operators and its two operands. Precedence is
 * already applied. Written brackets are a Group.
 */
export interface Binary {
  readonly kind: "binary";
  readonly op: "+" | "-" | "*" | "/";
  readonly left: Node;
  readonly right: Node;
}

/**
 * Unary is a leading minus, the only prefix operator.
 */
export interface Unary {
  readonly kind: "unary";
  readonly operand: Node;
}

/**
 * Group is a pair of written parentheses. It is kept so the text form
 * renders them back.
 */
export interface Group {
  readonly kind: "group";
  readonly inner: Node;
}

export type Node = NumLit | ColRef | Binary | Unary | Group;

/**
 * text renders a node in the form `parse` accepts, with one space either
 * side of a binary operator.
 */
export function text(n: Node): string {
  switch (n.kind) {
    case "num":
      return n.text;
    case "col":
      return n.name;
    case "binary":
      return text(n.left) + " " + n.op + " " + text(n.right);
    case "unary":
      return "-" + text(n.operand);
    case "group":
      return "(" + text(n.inner) + ")";
  }
}

function collectRefs(n: Node, into: Set<string>): void {
  switch (n.kind) {
    case "num":
      return;
    case "col":
      into.add(n.name);
      return;
    case "binary":
      collectRefs(n.left, into);
      collectRefs(n.right, into);
      return;
    case "unary":
      collectRefs(n.operand, into);
      return;
    case "group":
      collectRefs(n.inner, into);
      return;
  }
}

/**
 * Formula is one arithmetic expression, bound to a whole column. A Formula
 * whose root is undefined evaluates to EmptyFormulaError on every row.
 */
export class Formula {
  constructor(readonly root?: Node) {}

  /** The text form. "" when the root is undefined. */
  toString(): string {
    return this.root === undefined ? "" : text(this.root);
  }

  /**
   * refs returns every column name the expression reads, deduplicated and
   * sorted with `compareStrings`. The graph builds its edges from it.
   */
  refs(): string[] {
    const seen = new Set<string>();
    if (this.root !== undefined) collectRefs(this.root, seen);
    return [...seen].sort(compareStrings);
  }
}
