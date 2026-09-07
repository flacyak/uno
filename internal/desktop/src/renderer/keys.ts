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

/** Keys waiting for the one that finishes them, like the first c of cc. */
export interface Pending {
  readonly keys: string;
}

export const NOTHING: Pending = { keys: "" };

export type Motion = "left" | "right" | "up" | "down" | "page-down" | "page-up" | "home" | "end";

export type Action =
  | { t: "none" }
  | { t: "move"; motion: Motion }
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

/**
 * interpret reads one key in view or transform.
 *
 * Undefined means the key is not the grid's: a Ctrl or Cmd chord for the shell
 * and the menu, or Shift on its way to a capital. Those leave what is pending
 * alone, so the Shift in `cc`-then-`A` does not drop anything. Every other key
 * is the grid's, including the ones that do nothing, so a letter never reaches
 * the page as typing.
 */
export function interpret(mode: Mode, pending: Pending, press: Press): Step | undefined {
  if (press.ctrl || press.alt || press.meta) return undefined;
  const key = press.key;

  switch (key) {
    case "Escape":
      // Pending keys first. Someone who types a stray key and presses Esc means
      // "cancel that", not "lock the file".
      if (pending.keys !== "") return done(NONE);
      return done(mode === "transform" ? { t: "mode", to: "view" } : { t: "say", text: "" });
    case "ArrowDown":
      return done(move("down"));
    case "ArrowUp":
      return done(move("up"));
    case "ArrowRight":
    case "Tab":
      return done(move("right"));
    case "ArrowLeft":
      return done(move("left"));
    case "PageDown":
      return done(move("page-down"));
    case "PageUp":
      return done(move("page-up"));
    case "Home":
      return done(move("home"));
    case "End":
      return done(move("end"));
    case "Enter":
    case "F2":
      return done(open(mode, "all"));
  }

  // A named key that types nothing: Shift, CapsLock, a dead key.
  if (!ONE_CHARACTER.test(key)) return undefined;

  if (pending.keys === "c") return done(key === "c" ? open(mode, "empty") : NONE);

  switch (key) {
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
    case "c":
      return { pending: { keys: "c" }, action: NONE };
    case "u":
      return done(change(mode, press, { t: "undo" }));
  }
  return done(NONE);
}

/**
 * change is a key that writes. View refuses it, and a held key does nothing:
 * holding j should scroll, and holding u should not empty the log.
 */
function change(mode: Mode, press: Press, action: Action): Action {
  if (press.repeat) return NONE;
  return mode === "view" ? { t: "say", text: LOCKED } : action;
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

function done(action: Action): Step {
  return { pending: NOTHING, action };
}

function move(motion: Motion): Action {
  return { t: "move", motion };
}

/** open is a key that opens the editor, which view refuses. */
function open(mode: Mode, caret: Caret): Action {
  return mode === "view" ? { t: "say", text: LOCKED } : { t: "insert", caret, transform: false };
}
