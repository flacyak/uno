// Vim-style input: the grid's keys read the way vim reads them.
//
// uno has two modes and a cell editor, and vim has normal mode and insert mode.
// View is a normal mode that cannot write, transform is one that can, and the
// editor is insert. `i` moves one level in and Esc moves one level back out.
// The whole plan is resource/vim-motions.html.

import { NOTHING, isCharacter, showing } from "../keys.ts";
import type { Action, Caret, Mode, Motion, Pending, Press, Step } from "../keys.ts";
import type { EditorKey, InputStrategy } from "./strategy.ts";

const LOCKED = "View · i or Ctrl+E to transform";

const NONE: Action = { t: "none" };

/** The most digits a count keeps. Past that it could only be clamped to the sheet. */
const COUNT_DIGITS = 10;

/** A mark's name. */
const MARK = /^[a-z]$/;

/**
 * interpret reads one key in view or transform.
 *
 * Shift on its way to a capital is not the grid's, so the Shift in `5G` does not
 * drop the 5. A count applies to motions. A count typed before anything else is
 * dropped, because `3x` would record a set per cell.
 */
function interpret(mode: Mode, pending: Pending, press: Press): Step | undefined {
  if (press.alt || press.meta) return undefined;
  const key = press.key;
  const count = pending.count === "" ? undefined : Number(pending.count);

  if (press.ctrl) {
    // Redo, which is why the reload item gave up Ctrl+R.
    if (key.toLowerCase() === "r") return done(change(mode, press, { t: "redo" }));
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
  if (!isCharacter(key)) return undefined;

  if (pending.keys !== "") return done(finish(mode, press, pending.keys + key, count));

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
    case "H":
      return done(move("screen-top", count));
    case "M":
      return done(move("screen-middle", undefined));
    case "L":
      return done(move("screen-bottom", count));
    case "g":
    case "z":
    case "m":
    case "'":
    case "`":
    case "y":
    case "]":
    case "[":
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
    case "x":
      return done(change(mode, press, { t: "clear" }));
    case "p":
    case "P":
      // A cell has no before and after, so P puts where p does.
      return done(change(mode, press, { t: "put" }));
    case ".":
      return done(change(mode, press, { t: "repeat" }));
    case ":":
      return done({ t: "prompt", lead: ":" });
    case "/":
      return done({ t: "prompt", lead: "/" });
    case "?":
      return done({ t: "prompt", lead: "?" });
    case "n":
      return done({ t: "next", reverse: false });
    case "N":
      return done({ t: "next", reverse: true });
  }
  return done(NONE);
}

/** finish reads the second key of two. One that finishes nothing drops both, and the count. */
function finish(mode: Mode, press: Press, keys: string, count: number | undefined): Action {
  const [first, second] = [keys.slice(0, 1), keys.slice(1)];
  if (first === "m") return MARK.test(second) ? { t: "mark", name: second } : NONE;
  // Both go to the cell, row and column. A sheet has no line-versus-character
  // split worth two different keys.
  if (first === "'" || first === "`") {
    if (second === "'" || second === "`") return { t: "back" };
    return MARK.test(second) ? { t: "to-mark", name: second } : NONE;
  }

  switch (keys) {
    case "gg":
      return move("first-row", count);
    case "ga":
      return change(mode, press, { t: "apply" });
    case "gx":
      return change(mode, press, { t: "dismiss" });
    case "zt":
      return { t: "scroll", where: "top" };
    case "zz":
      return { t: "scroll", where: "middle" };
    case "zb":
      return { t: "scroll", where: "bottom" };
    case "yy":
      return { t: "yank" };
    case "]f":
      return { t: "unparsed", dir: 1 };
    case "[f":
      return { t: "unparsed", dir: -1 };
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
 * editorKey ends the insert on Enter and on Esc, and both keep the typing. Vim
 * users press Esc at the end of every insert, and losing the text each time
 * would make the keys useless. A value that did not change records nothing.
 */
function editorKey(key: string, composing: boolean): EditorKey {
  if (composing || key === "Process") return undefined;
  return key === "Enter" || key === "Escape" ? "commit" : undefined;
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

export const vimStyle: InputStrategy = {
  name: "vim-style",
  locked: LOCKED,
  // Transform with the editor open, which is vim's insert mode.
  editing: "INSERT",
  switchHint: "i to transform · Esc to view · Ctrl+E",
  interpret,
  editorKey,
};
