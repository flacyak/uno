// What the grid draws and what it tells the shell. Types only, so the shell and
// the workspace can name them without loading the grid.

import type { Kind } from "@uno/grid/sheet";

import type { Action, Mode } from "../keys.ts";

/**
 * Rows is what the grid draws. A Sheet is one, and so is an engine's band.
 *
 * The optional methods are the band's. A Sheet has every row, so it has nothing
 * to say about which have arrived, how far the index has got, or what is on
 * screen.
 */
export interface Rows {
  readonly columns: readonly { header: string; kind: Kind; flagged: boolean }[];
  rows(): number;
  cols(): number;
  display(row: number, col: number): string;
  raw(row: number, col: number): string;
  binding(col: number): string | undefined;
  ready?(row: number): boolean;
  /** Rows the engine can answer for now, which is where G stops while a file indexes. */
  readable?(): number;
  view?(first: number, count: number): void;
}

export interface GridEvents {
  /** The selection moved, so the status bar can say where it is. */
  onSelect(row: number, col: number): void;
  /** A cell was committed. The sheet has already been told; this is for
   * everything that follows from an edit. */
  onEdit(row: number, col: number, value: string): void;
  /** A key has something to say: why it did nothing, or nothing, to clear the line. */
  onSay(text: string, isError: boolean): void;
  /** A key asked for the other mode. The shell switches, then shows the rows again. */
  onMode(to: Mode): void;
  /** The editor opened or closed, so the status bar can say INSERT. */
  onEditor(open: boolean): void;
  /** Keys are waiting for more, or stopped waiting: what the status bar shows of them. */
  onPending(keys: string): void;
  /**
   * A motion stopped at the last row the engine can read, short of the row it
   * asked for, or of the end.
   */
  onShort(wanted: number | "end"): void;
  /** A key the grid cannot carry out itself, because the workspace does. */
  onAction(action: ShellAction): void;
}

export interface Cell {
  row: number;
  col: number;
}

/** The actions that belong to the shell rather than the grid. */
export type ShellAction = Extract<
  Action,
  { t: "undo" | "redo" | "apply" | "dismiss" | "prompt" | "unparsed" | "next" }
>;
