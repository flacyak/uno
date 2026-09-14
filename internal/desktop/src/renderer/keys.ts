// The grid's keys, read the way vim reads them.
//
// uno has two modes and a cell editor, and vim has normal mode and insert mode.
// View is a normal mode that cannot write, transform is one that can, and the
// editor is insert. `i` moves one level in and Esc moves one level back out.
//
// This file says what a key means and does nothing about it. It never touches
// the DOM, so a test can press every key without a window -- the same property
// the header of main.ts says the shell exists to keep.

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
  // the first and last cell of the sheet
  | "home"
  | "end";

export type Action =
  | { t: "none" }
  | { t: "move"; motion: Motion; count: number | undefined }
  | { t: "mode"; to: Mode }
  /** Open the editor. `transform` switches to transform first, which is `a` in view. */
  | { t: "insert"; caret: Caret; transform: boolean }
  | { t: "undo" }
  | { t: "say"; text: string };

export interface Step {
  pending: Pending;
  action: Action;
}

/** What a key that writes says in view. */
export const LOCKED = "View · i or Ctrl+E to transform";

const NONE: Action = { t: "none" };

/** One code point, so a character outside the BMP counts as the one key it is. */
const ONE_CHARACTER = /^.$/u;

/** The most digits a count keeps. Past that it could only be clamped to the sheet. */
const COUNT_DIGITS = 10;

/**
 * interpret reads one key in view or transform.
 *
 * Undefined means the key is not the grid's: a chord for the shell and the
 * menu, or Shift on its way to a capital. Those leave what is pending alone, so
 * the Shift in `5G` does not drop the 5. Every other key is the grid's,
 * including the ones that do nothing, so a letter never reaches the page as
 * typing.
 *
 * A count applies to motions. A count typed before anything else is dropped,
 * because `3x` would record a set per cell.
 */
export function interpret(mode: Mode, pending: Pending, press: Press): Step | undefined {
  if (press.alt || press.meta) return undefined;
  const key = press.key;
  const count = pending.count === "" ? undefined : Number(pending.count);

  if (press.ctrl) {
    const motion = ctrlMotion(key);
    return motion === undefined ? undefined : done(move(motion, count));
  }

  switch (key) {
    case "Escape":
      // Pending keys first. Someone who types 4 by mistake and presses Esc means
      // "cancel the 4", not "lock the file".
      if (showing(pending) !== "") return done(NONE);
      return done(mode === "transform" ? { t: "mode", to: "view" } : { t: "say", text: "" });
    case "ArrowDown":
      return done(move("down", count));
    case "ArrowUp":
      return done(move("up", count));
    case "ArrowRight":
    case "Tab":
      return done(move("right", count));
    case "ArrowLeft":
      return done(move("left", count));
    case "PageDown":
      return done(move("page-down", count));
    case "PageUp":
      return done(move("page-up", count));
    case "Home":
      return done(move("home", undefined));
    case "End":
      return done(move("end", undefined));
    case "Enter":
    case "F2":
      return done(open(mode, "all"));
  }

  // A named key that types nothing: Shift, CapsLock, a dead key.
  if (!ONE_CHARACTER.test(key)) return undefined;

  if (pending.keys !== "") return done(finish(mode, pending.keys + key, count));

  // 0 is a digit once a count has started, as in 10j, and a motion otherwise.
  if ((key >= "1" && key <= "9") || (key === "0" && pending.count !== "")) {
    const digits = pending.count.length < COUNT_DIGITS ? pending.count + key : pending.count;
    return { pending: { count: digits, keys: "" }, action: NONE };
  }

  switch (key) {
    case "h":
      return done(move("left", count));
    case "j":
      return done(move("down", count));
    case "k":
      return done(move("up", count));
    case "l":
      return done(move("right", count));
    case "w":
      return done(move("next", count));
    case "b":
      return done(move("previous", count));
    case "0":
    case "^":
      return done(move("first-col", count));
    case "$":
      return done(move("last-col", undefined));
    case "G":
      return done(move("last-row", count));
    case "g":
    case "c":
      return { pending: { count: pending.count, keys: key }, action: NONE };
    case "i":
    case "I":
      // In view, i stops at transform. Writing should follow a decision to write,
      // and `i i` is a cheap way to make one.
      return done(mode === "view" ? { t: "mode", to: "transform" } : open(mode, "start"));
    case "a":
    case "A":
      // a is specific enough to count as the decision, so it goes all the way.
      return done({ t: "insert", caret: "end", transform: mode === "view" });
    case "s":
      return done(open(mode, "empty"));
    case "u":
      return done(change(mode, press, { t: "undo" }));
  }
  return done(NONE);
}

/** finish reads the second key of two. One that finishes nothing drops both, and the count. */
function finish(mode: Mode, keys: string, count: number | undefined): Action {
  switch (keys) {
    case "gg":
      return move("first-row", count);
    case "cc":
      return open(mode, "empty");
  }
  return NONE;
}

function ctrlMotion(key: string): Motion | undefined {
  switch (key.toLowerCase()) {
    case "d":
      return "half-down";
    case "u":
      return "half-up";
    case "f":
      return "page-down";
    case "b":
      return "page-up";
  }
  return undefined;
}

/**
 * leavesInsert says whether a key in the cell editor ends the insert. Enter and
 * Esc both do, and both keep the typing. While an input method is composing,
 * Esc ends the composition instead, and closing the editor would cut a word in
 * half.
 */
export function leavesInsert(key: string, composing: boolean): boolean {
  if (composing || key === "Process") return false;
  return key === "Enter" || key === "Escape";
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

function done(action: Action): Step {
  return { pending: NOTHING, action };
}

function move(motion: Motion, count: number | undefined): Action {
  return { t: "move", motion, count };
}

/** open is a key that opens the editor, which view refuses. */
function open(mode: Mode, caret: Caret): Action {
  return mode === "view" ? { t: "say", text: LOCKED } : { t: "insert", caret, transform: false };
}

/**
 * change is a key that writes. View refuses it, and a held key does nothing:
 * holding j should scroll, and holding u should not empty the log.
 */
function change(mode: Mode, press: Press, action: Action): Action {
  if (press.repeat) return NONE;
  return mode === "view" ? { t: "say", text: LOCKED } : action;
}
