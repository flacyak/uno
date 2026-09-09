// The expression tree.
//
// In Go this is a sealed interface: `node` has an unexported method, so the set
// of terms is closed at five and the evaluator's type switch is exhaustive by
// construction. A discriminated union is the same guarantee here, and the
// `never` tail in eval.ts is what makes the compiler check it.

import { compareStrings } from "../go/index.ts";

/**
 * NumLit keeps the text it was written as, not only the value it parsed to.
 *
 * 40.00 and 40 are one number and two different things to read, and an editor
 * that rewrites a literal while somebody is still typing it is one they stop
 * trusting. The value is carried alongside so evaluation does not re-parse the
 * text once per row.
 */
export interface NumLit {
  readonly kind: "num";
  readonly text: string;
  readonly value: number;
}

/**
 * ColRef names a column by its header, not by an index or an ID.
 *
 * `sheet` owns header-to-index resolution, and a formula that stored an index
 * would be a formula that silently meant a different column after an insert --
 * and one nobody could read in a .unof.
 *
 * A header that is not a valid identifier cannot be referenced. That is a
 * stated limit rather than a reason to invent a quoting syntax: a second
 * spelling of every name would have to round-trip, and the answer to a column
 * called "Q3 (net)" is to rename it.
 */
export interface ColRef {
  readonly kind: "col";
  readonly name: string;
}

/**
 * Binary is one operator and its two operands, already shaped by precedence, so
 * the tree says what the arithmetic means and rendering never has to guess
 * where a bracket is needed. Where a bracket was written, Group holds it.
 */
export interface Binary {
  readonly kind: "binary";
  readonly op: "+" | "-" | "*" | "/";
  readonly left: Node;
  readonly right: Node;
}

/**
 * Unary is a leading minus. There is no unary plus: +x means x, so accepting it
 * would give one expression two spellings and both would have to round-trip.
 */
export interface Unary {
  readonly kind: "unary";
  readonly operand: Node;
}

/**
 * Group is a real node rather than a hint dropped after parsing, so a person's
 * own parentheses come back out of the file the way they went in.
 *
 * They are how someone shows their working -- (price - cost) / price is read as
 * a fraction -- and a build that quietly removed the redundant ones would be
 * editing an expression it was only asked to store.
 */
export interface Group {
  readonly kind: "group";
  readonly inner: Node;
}

export type Node = NumLit | ColRef | Binary | Unary | Group;

/**
 * text renders a term back into the form `parse` accepts.
 *
 * It renders from the tree rather than handing back the source it was parsed
 * from. Returning the source would make the round trip true by construction and
 * tell nobody whether the tree agrees with it, which is the one thing the text
 * form is for. The price is that spacing is normalised -- one space either side
 * of a binary operator -- so this is a normal form and not a transcription of
 * what was typed.
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
 * Formula is one arithmetic expression, bound to a whole column rather than to
 * a cell.
 *
 * Whole-column scope is the constraint the whole design rests on: it is what
 * keeps the dependency graph one node per column instead of one per cell.
 *
 * An empty Formula evaluates to a failure rather than a crash. A binding
 * arrives out of a state.json written by some other build, and a missing
 * expression must fail as a value on the path that reads it.
 */
export class Formula {
  constructor(readonly root?: Node) {}

  /** The text form, rendered from the tree. See `text`. */
  toString(): string {
    return this.root === undefined ? "" : text(this.root);
  }

  /**
   * refs names every column the expression reads, sorted and deduplicated.
   *
   * This is the walk cycle detection is built on, so it has to be the whole
   * truth about what a formula depends on: a reference this misses is an edge
   * the graph does not have, and an edge the graph does not have is a cycle it
   * accepts.
   *
   * Sorted because the order reaches a person, in the .unof's refs and in the
   * path a refused binding names, and an order that changes between runs is one
   * nobody can diff. The comparator is Go's, not JavaScript's -- see
   * `compareStrings`.
   */
  refs(): string[] {
    const seen = new Set<string>();
    if (this.root !== undefined) collectRefs(this.root, seen);
    return [...seen].sort(compareStrings);
  }
}
