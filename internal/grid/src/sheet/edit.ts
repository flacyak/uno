/**
 * Edit is one recorded change, and one line of the .uno edit log.
 *
 * A sheet keeps every edit in order. Replay rebuilds the sheet from the raw
 * source and the log, and undo truncates the log and replays.
 *
 * `was` is the value before the edit, where the edit has one. A column
 * operation leaves it undefined, so every reader treats it as optional.
 */
export interface Edit {
  seq: number;
  op: Op;
  /** The row, or NO_ROW for a column operation. */
  row: number;
  col: number;
  was?: string;

  /**
   * The new value under "set", the markdown source under "note", the
   * program text under "apply" and the expression text under "bind".
   */
  now: string;
}

/**
 * The operations, as spelled in the file.
 */
export const Op = {
  /** Sets one cell. */
  Set: "set",

  /**
   * Runs a program over a whole column. Leaves `was` undefined.
   */
  Apply: "apply",

  /**
   * Puts notation in one cell: markdown is stored, the rendered symbols are
   * shown. It stands alone, outside the dependency graph.
   */
  Note: "note",

  /**
   * Binds a formula to a column. The column then shows what the expression
   * computes in place of its stored values. It is logged so it can be
   * undone.
   */
  Bind: "bind",

  /**
   * Takes the formula off a column. The column shows its stored values
   * again. `was` carries the expression removed.
   */
  Unbind: "unbind",
} as const;

export type Op = (typeof Op)[keyof typeof Op];

/**
 * NO_ROW is what a column operation stores in `row`.
 */
export const NO_ROW = -1;

/** editEquals compares two edits field by field. A missing `was` equals "". */
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
