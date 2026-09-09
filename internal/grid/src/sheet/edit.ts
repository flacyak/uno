/**
 * Edit is one recorded change, and the unit the .uno edit log stores.
 *
 * A sheet keeps every edit made to it in order, because that log plus the
 * immutable raw source is the whole truth of a saved workspace: replay rebuilds
 * it, and undo is truncate-and-replay rather than a stack held in memory.
 *
 * `was` is what makes an edit readable on its own, in a diff or an unzip,
 * without replaying anything up to it. Operations that change thousands of
 * cells at once will not carry one, so nothing may depend on it being present.
 */
export interface Edit {
  seq: number;
  op: Op;
  /** Position today, NO_ROW on a column operation. */
  row: number;
  col: number;
  was?: string;

  /**
   * now is the cell's new value under "set", the markdown source under "note",
   * the program text under "apply" and the expression text under "bind".
   *
   * One field rather than four because they are the same thing at different
   * scopes -- what this operation makes the data say -- and a second field
   * would have to be empty in every line of every log written so far.
   */
  now: string;
}

/**
 * The operations.
 *
 * Each is spelled out in the file so a reader that predates one of them can
 * tell a row-spanning rule from a single cell rather than guessing from which
 * fields happen to be set.
 */
export const Op = {
  /** One cell, and the only operation the first release wrote. */
  Set: "set",

  /**
   * A program run over a whole column: the transformation the recogniser
   * induced from a handful of edits and the person agreed to. It carries no
   * `was`, because thousands of old values are not a field, which is why undo
   * replays the log rather than reversing it.
   */
  Apply: "apply",

  /**
   * Notation in one cell: markdown stored, symbols shown.
   *
   * It is one cell like Set and derived like Bind, and it is neither of them --
   * setting a cell would lose the source the symbols came from, and binding
   * would make a thing that reads no columns join a dependency graph.
   */
  Note: "note",

  /**
   * Makes a column derived: from here on it stores nothing of its own and shows
   * what the expression computes.
   *
   * It is an operation and not a line of sheet state, though it looks like one.
   * A binding is something a person did, so it has to be something they can
   * undo, and undo is truncate-and-replay of this log. Putting it in state.json
   * would have left Ctrl+Z unable to reach it.
   */
  Bind: "bind",

  /**
   * Takes the formula back off a column, and the column goes back to showing
   * the values stored under it.
   *
   * It is the inverse of Bind and not the absence of it. Undo is
   * truncate-and-replay, so the only other way to take a binding off is to take
   * back everything done since, and a column bound twenty edits ago by somebody
   * else is exactly the one a person wants rid of without losing the twenty. It
   * carries the expression it removed in `was`, so an unbind line says what it
   * undid to anyone reading the log with unzip.
   */
  Unbind: "unbind",
} as const;

export type Op = (typeof Op)[keyof typeof Op];

/**
 * NO_ROW is what a column-spanning operation stores in `row`.
 *
 * A log is read by people with unzip as well as by uno, and -1 says "this one
 * is not about a row" where a plausible 0 would quietly point at the first one.
 */
export const NO_ROW = -1;

/** Structural equality over the log, for `logEquals`. */
export function editEquals(a: Edit, b: Edit): boolean {
  return (
    a.seq === b.seq &&
    a.op === b.op &&
    a.row === b.row &&
    a.col === b.col &&
    (a.was ?? "") === (b.was ?? "") &&
    a.now === b.now
  );
}
