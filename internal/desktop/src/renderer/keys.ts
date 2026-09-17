// What the grid's keys mean, whichever way they are read.
//
// An input strategy (input/) turns a key into one of these actions, and the
// grid carries the action out. Where a motion lands, what . makes again and what
// a command says are the same whichever strategy asked, so they live here. None
// of it touches the DOM, so a test can drive every key without a window -- the
// same property the header of shell/shell.ts says the shell exists to keep.

export type Mode = "view" | "transform";

/** Where the caret starts when the editor opens. */
export type Caret = "start" | "end" | "all" | "empty";

/** The part of a KeyboardEvent the keys read. */
export interface Press {
  key: string;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  /** The key is held down and repeating. */
  repeat: boolean;
}

/** Keys that wait for more: a count, and a key waiting for the one that finishes it. */
export interface Pending {
  /** The count's digits, or "" for none. */
  readonly count: string;
  /** The first key of two, like the g of gg. */
  readonly keys: string;
}

export const NOTHING: Pending = { count: "", keys: "" };

/** showing is what the status bar shows of pending keys, where vim's showcmd would. */
export function showing(pending: Pending): string {
  return pending.count + pending.keys;
}

/** One code point, so a character outside the BMP counts as the one key it is. */
const ONE_CHARACTER = /^.$/u;

/** isCharacter says whether a key types a character, rather than naming one like Shift. */
export function isCharacter(key: string): boolean {
  return ONE_CHARACTER.test(key);
}

export type Motion =
  | "left"
  | "right"
  | "up"
  | "down"
  // w and b: the next and previous cell in reading order
  | "next"
  | "previous"
  | "first-col"
  | "last-col"
  | "first-row"
  | "last-row"
  | "page-down"
  | "page-up"
  | "half-down"
  | "half-up"
  // H M L: the top, middle and bottom row on screen
  | "screen-top"
  | "screen-middle"
  | "screen-bottom"
  // the first and last cell of the sheet
  | "home"
  | "end";

export type Action =
  | { t: "none" }
  | { t: "move"; motion: Motion; count: number | undefined }
  /** zt zz zb: scroll the selected row to the top, middle or bottom. The selection stays. */
  | { t: "scroll"; where: "top" | "middle" | "bottom" }
  /** m{a-z}: remember the selected cell by a letter. */
  | { t: "mark"; name: string }
  /** '{a-z} and `{a-z}: go to a marked cell. */
  | { t: "to-mark"; name: string }
  /** '' and ``: go back to where the last jump left from. */
  | { t: "back" }
  | { t: "mode"; to: Mode }
  /**
   * Open the editor. `transform` switches to transform first, which is `a` in
   * view. `text` starts it holding that instead of the value: typing over a cell.
   */
  | { t: "insert"; caret: Caret; transform: boolean; text?: string }
  | { t: "undo" }
  /** Record again what undo took back. */
  | { t: "redo" }
  /** Set the cell to "". */
  | { t: "clear" }
  /** Copy what the cell stores. It changes nothing, so view allows it. */
  | { t: "yank" }
  /** Set the cell to what was copied. */
  | { t: "put" }
  /** Do the last insert, clear or put again, on the selected cell. */
  | { t: "repeat" }
  /** Apply on the banner. */
  | { t: "apply" }
  /** Not now on the banner. */
  | { t: "dismiss" }
  /** The command line, or a search down or up. */
  | { t: "prompt"; lead: Lead }
  /** The next or previous cell in the column that does not parse as its kind. */
  | { t: "unparsed"; dir: 1 | -1 }
  /** The last search again, the same way or the other. */
  | { t: "next"; reverse: boolean }
  | { t: "say"; text: string };

/** What the command line opens with: a command, or a search down or up. */
export type Lead = ":" | "/" | "?";

export interface Step {
  pending: Pending;
  action: Action;
}

/**
 * isJump says whether a motion is a jump, which '' goes back from: G, gg and
 * {n}G, and H, M and L. Going to a mark is one too. It keeps one position, not
 * a jumplist.
 */
export function isJump(motion: Motion): boolean {
  switch (motion) {
    case "first-row":
    case "last-row":
    case "screen-top":
    case "screen-middle":
    case "screen-bottom":
      return true;
    default:
      return false;
  }
}

/** A command typed at the : prompt. */
export type Command =
  | { t: "none" }
  | { t: "write" }
  | { t: "save-as" }
  | { t: "open"; force: boolean }
  /** :{n}, a row numbered from 1. */
  | { t: "row"; row: number }
  | { t: "unknown"; text: string };

/**
 * command reads what was typed after the colon. There is no :q or :wq. Closing
 * is the window's job, and quitting with unsaved edits over a mistyped command
 * is a bad trade for two saved keystrokes.
 */
export function command(text: string): Command {
  const typed = text.trim();
  if (typed === "") return { t: "none" };
  if (/^\d+$/.test(typed)) return { t: "row", row: Number(typed) };
  switch (typed) {
    case "w":
    case "write":
      return { t: "write" };
    case "sav":
    case "saveas":
      return { t: "save-as" };
    case "e":
    case "edit":
      return { t: "open", force: false };
    case "e!":
    case "edit!":
      return { t: "open", force: true };
  }
  return { t: "unknown", text: typed };
}

/** A change . can make again on another cell. */
export type Change =
  | { t: "set"; value: string }
  | { t: "append"; text: string }
  | { t: "prepend"; text: string };

/**
 * changeOf works out what an insert did by comparing the value it left with the
 * one it started from. Opened at the end and only added to there, it repeats as
 * an append; opened at the start and only added to there, as a prepend.
 * Anything else repeats as the whole value, which is still right for the common
 * case, several cells holding the same bad value.
 */
export function changeOf(caret: Caret, before: string, after: string): Change {
  if (caret === "end" && after.startsWith(before)) {
    return { t: "append", text: after.slice(before.length) };
  }
  if (caret === "start" && after.endsWith(before)) {
    return { t: "prepend", text: after.slice(0, after.length - before.length) };
  }
  return { t: "set", value: after };
}

/** replay is what a change makes of a cell's value. */
export function replay(change: Change, value: string): string {
  switch (change.t) {
    case "set":
      return change.value;
    case "append":
      return value + change.text;
    case "prepend":
      return change.text + value;
  }
}

/** Where the selection is and what is around it: what a motion needs to land. */
export interface Place {
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** Rows the engine can answer for now. The same as rows once the index is done. */
  readable: number;
  /** Rows a page moves. */
  page: number;
  /** The first and last rows wholly on screen. */
  top: number;
  bottom: number;
}

export interface Target {
  row: number;
  col: number;
  /**
   * Set when the motion stopped at the last indexed row, short of where it was
   * going: the row it asked for, or "end" for G on its own.
   */
  short?: number | "end";
}

/**
 * target works out where a motion lands. It clamps to the sheet rather than
 * wrapping, and it moves by arithmetic rather than a step at a time, so a count
 * of fifty million costs what one does.
 */
export function target(motion: Motion, count: number | undefined, at: Place): Target {
  const n = count ?? 1;
  const lastRow = Math.max(0, at.rows - 1);
  const lastCol = Math.max(0, at.cols - 1);
  const cell = (row: number, col: number): Target => ({
    row: clamp(row, lastRow),
    col: clamp(col, lastCol),
  });

  switch (motion) {
    case "down":
      return cell(at.row + n, at.col);
    case "up":
      return cell(at.row - n, at.col);
    case "right":
      return cell(at.row, at.col + n);
    case "left":
      return cell(at.row, at.col - n);
    case "next":
    case "previous": {
      const cols = lastCol + 1;
      const from = at.row * cols + at.col;
      const to = clamp(from + (motion === "next" ? n : -n), lastRow * cols + lastCol);
      return { row: Math.floor(to / cols), col: to % cols };
    }
    case "first-col":
      return cell(at.row, 0);
    case "last-col":
      return cell(at.row, lastCol);
    case "page-down":
      return cell(at.row + n * at.page, at.col);
    case "page-up":
      return cell(at.row - n * at.page, at.col);
    case "half-down":
      return cell(at.row + n * half(at.page), at.col);
    case "half-up":
      return cell(at.row - n * half(at.page), at.col);
    case "screen-top":
      return cell(Math.min(at.top + n - 1, at.bottom), at.col);
    case "screen-middle":
      return cell(at.top + Math.floor((at.bottom - at.top) / 2), at.col);
    case "screen-bottom":
      return cell(Math.max(at.bottom - n + 1, at.top), at.col);
    case "home":
      return cell(0, 0);
    case "end":
      return cell(lastRow, lastCol);
    case "first-row":
    case "last-row": {
      // With a count both go to row n, numbered from 1 the way the gutter is.
      const wanted = count !== undefined ? count - 1 : motion === "first-row" ? 0 : undefined;

      // While the file indexes, the row count is a projection. Going past what
      // the engine can read would land on rows that stay pending.
      const indexing = at.readable < at.rows;
      const lastReadable = Math.max(0, at.readable - 1);
      if (wanted === undefined) {
        return indexing ? { ...cell(lastReadable, at.col), short: "end" } : cell(lastRow, at.col);
      }
      if (indexing && wanted >= at.readable) {
        return { ...cell(lastReadable, at.col), short: wanted };
      }
      return cell(wanted, at.col);
    }
  }
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

/** Half a page, and at least one row. */
function half(page: number): number {
  return Math.max(1, Math.floor(page / 2));
}
