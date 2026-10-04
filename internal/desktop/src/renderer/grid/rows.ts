// Types shared by the grid, the shell and the workspace: the data the grid
// draws, the events it raises, and column labels. Importing it leaves the
// grid itself unloaded.

import type { Kind } from "@uno/grid/sheet";

import { m } from "../../paraglide/messages.js";
import type { Action, Mode } from "../keys.ts";

/** Returns a column's display name. A blank header is named by its 1-based
 * position. */
export function columnLabel(header: string, col: number): string {
  return unnamed(header) ? m.column_unnamed({ number: col + 1 }) : header;
}

/** Returns whether a header is blank. */
export function unnamed(header: string): boolean {
  return header.trim() === "";
}

/**
 * The data the grid draws. Implemented by a Sheet and by an engine's band.
 *
 * The optional methods are implemented by the band only. A Sheet has every
 * row loaded.
 */
export interface Rows {
  readonly columns: readonly { header: string; kind: Kind; flagged: boolean }[];
  rows(): number;
  cols(): number;
  display(row: number, col: number): string;
  raw(row: number, col: number): string;
  binding(col: number): string | undefined;
  ready?(row: number): boolean;
  /** Number of rows the engine can read so far. Caps G while a file is
   * still indexing. */
  readable?(): number;
  view?(first: number, count: number): void;
}

export interface GridEvents {
  /** The selection moved. */
  onSelect(row: number, col: number): void;
  /** A cell value was committed. */
  onEdit(row: number, col: number, value: string): void;
  /** Show a message in the status line. Empty text clears it. */
  onSay(text: string, isError: boolean): void;
  /** A key asked to switch mode. */
  onMode(to: Mode): void;
  /** The cell editor opened or closed. */
  onEditor(open: boolean): void;
  /** The pending key display changed. Empty once the sequence completes. */
  onPending(keys: string): void;
  /** A motion stopped at the last readable row, short of the row it asked
   * for (a number or "end"). */
  onShort(wanted: number | "end"): void;
  /** An action the shell carries out. */
  onAction(action: ShellAction): void;
}

export interface Cell {
  row: number;
  col: number;
}

/** Actions carried out by the shell. */
export type ShellAction = Extract<
  Action,
  { t: "undo" | "redo" | "apply" | "dismiss" | "prompt" | "unparsed" | "next" | "tab" }
>;
