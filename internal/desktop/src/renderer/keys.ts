// The actions the grid's keys map to, shared by every input strategy.
//
// An input strategy (input/) turns a key press into an Action, and the grid
// carries it out. Motion targets, repeatable changes and command parsing live
// here. This file is plain logic, so tests run it directly.

export type Mode = "view" | "transform";

/** Where the caret starts when the editor opens. */
export type Caret = "start" | "end" | "all" | "empty";

/** The fields of a KeyboardEvent the input strategies read. */
export interface Press {
  key: string;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  /** Shift state. Tab uses it to reverse direction. A letter's case is in `key`. */
  shift: boolean;
  /** The key is held down and auto-repeating. */
  repeat: boolean;
}

/** Keys typed so far that are waiting for more: a count and a prefix key. */
export interface Pending {
  /** The count's digits, or "" for none. */
  readonly count: string;
  /** The first key of a two-key sequence, like the g of gg. */
  readonly keys: string;
}

export const NOTHING: Pending = { count: "", keys: "" };

/** Returns the pending keys as the status bar shows them. */
export function showing(pending: Pending): string {
  return pending.count + pending.keys;
}

/** Matches exactly one code point, including characters outside the BMP. */
const ONE_CHARACTER = /^.$/u;

/** Returns whether a key value is a single typed character, as opposed to a name like Shift. */
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
  /** m{a-z}: store the selected cell under a letter. */
  | { t: "mark"; name: string }
  /** '{a-z} and `{a-z}: go to a marked cell. */
  | { t: "to-mark"; name: string }
  /** '' and ``: go back to where the last jump started. */
  | { t: "back" }
  | { t: "mode"; to: Mode }
  /**
   * Open the editor. `transform` switches to transform mode first. `text`
   * replaces the cell's value as the starting content.
   */
  | { t: "insert"; caret: Caret; transform: boolean; text?: string }
  | { t: "undo" }
  /** Redo the last undone edit. */
  | { t: "redo" }
  /** Set the cell to "". */
  | { t: "clear" }
  /** Copy the cell's stored value. Allowed in view mode. */
  | { t: "yank" }
  /** Set the cell to the copied value. */
  | { t: "put" }
  /** Repeat the last insert, clear or put on the selected cell. */
  | { t: "repeat" }
  /** Press Apply on the banner. */
  | { t: "apply" }
  /** Press Not now on the banner. */
  | { t: "dismiss" }
  /** Open the command line or a search prompt. */
  | { t: "prompt"; lead: Lead }
  /** Go to the next or previous cell in the column that fails to parse as its kind. */
  | { t: "unparsed"; dir: 1 | -1 }
  /** Repeat the last search, forward or reversed. */
  | { t: "next"; reverse: boolean }
  /**
   * gt and gT: switch tab. A count after gt is the tab number to go to, from
   * 1. A count after gT is how many tabs to go back.
   */
  | { t: "tab"; step: 1 | -1; count: number | undefined }
  | { t: "say"; text: string };

/** The character a prompt opens with: a command, a forward search, or a backward search. */
export type Lead = ":" | "/" | "?";

export interface Step {
  pending: Pending;
  action: Action;
}

export const NONE: Action = { t: "none" };

/** Returns a Step with the action and an empty Pending. */
export function done(action: Action): Step {
  return { pending: NOTHING, action };
}

export function move(motion: Motion, count: number | undefined): Action {
  return { t: "move", motion, count };
}

/**
 * Named keys that map to a motion under every input strategy. Tab is handled
 * separately because Shift reverses it. A Map, so a key named like an Object
 * property matches only an entry.
 */
export const NAMED_MOTIONS: ReadonlyMap<string, Motion> = new Map([
  ["ArrowDown", "down"],
  ["ArrowUp", "up"],
  ["ArrowRight", "right"],
  ["ArrowLeft", "left"],
  ["PageDown", "page-down"],
  ["PageUp", "page-up"],
  ["Home", "home"],
  ["End", "end"],
]);

export function isLead(key: string): key is Lead {
  return key === ":" || key === "/" || key === "?";
}

/**
 * Returns whether a motion is a jump, which '' goes back from: G, gg, {n}G,
 * H, M and L. Going to a mark is also a jump. Only one position is kept.
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
  /** :sources, opens the sources panel. */
  | { t: "sources" }
  /** :{n}, go to a row numbered from 1. */
  | { t: "row"; row: number }
  | { t: "unknown"; text: string };

/**
 * Parses the text typed after the colon. Closing is done through the window,
 * so :q and :wq parse as unknown.
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
    case "sources":
      return { t: "sources" };
  }
  return { t: "unknown", text: typed };
}

/** A change that . can repeat on another cell. */
export type Change =
  | { t: "set"; value: string }
  | { t: "append"; text: string }
  | { t: "prepend"; text: string };

/**
 * Works out what an insert did by comparing the value before and after. An
 * insert opened at the end that only added text is an append; one opened at
 * the start that only added text is a prepend. Anything else is a set of the
 * whole value.
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

/** Applies a change to a cell's value and returns the result. */
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

/** The selection and the sheet around it: the inputs a motion needs. */
export interface Place {
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** Rows the engine can read now. Equals rows once indexing is done. */
  readable: number;
  /** Rows per page. */
  page: number;
  /** The first and last rows fully on screen. */
  top: number;
  bottom: number;
}

export interface Target {
  row: number;
  col: number;
  /**
   * Set when the motion stopped short at the last readable row: the row that
   * was asked for, or "end" for a bare G.
   */
  short?: number | "end";
}

/**
 * Returns where a motion lands, clamped to the sheet. Computed by arithmetic,
 * so the cost is the same for every count.
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
      // With a count, both go to row n, numbered from 1.
      const wanted = count !== undefined ? count - 1 : motion === "first-row" ? 0 : undefined;

      // While indexing, the row count is an estimate. The target is clamped
      // to the last readable row and marked short.
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

/** Half a page, at least one row. */
function half(page: number): number {
  return Math.max(1, Math.floor(page / 2));
}
