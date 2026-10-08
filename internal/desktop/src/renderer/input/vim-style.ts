// Vim-style input: the grid's keys read the way vim reads them.
//
// uno has two modes and a cell editor, and vim has normal mode and insert mode.
// View is a normal mode that cannot write, transform is one that can, and the
// editor is insert. `i` moves one level in and Esc moves one level back out.

import { m } from "../../paraglide/messages.js";
import { NAMED_MOTIONS, NONE, done, isCharacter, isLead, move, showing } from "../keys.ts";
import type { Action, Caret, Mode, Motion, Pending, Press, Step } from "../keys.ts";
import type { EditorKey, InputStrategy } from "./strategy.ts";

/** The most digits a count keeps. Past that it could only be clamped to the sheet. */
const COUNT_DIGITS = 10;

/** A mark's name. */
const MARK = /^[a-z]$/;

/** The letters that move, as vim has them. 0 is among them only before a count starts. */
const LETTER_MOTIONS: ReadonlyMap<string, Motion> = new Map([
  ["h", "left"],
  ["j", "down"],
  ["k", "up"],
  ["l", "right"],
  ["w", "next"],
  ["b", "previous"],
  ["0", "first-col"],
  ["^", "first-col"],
  ["$", "last-col"],
  ["G", "last-row"],
  ["H", "screen-top"],
  ["M", "screen-middle"],
  ["L", "screen-bottom"],
]);

/** The motions a count means nothing to: there is one end, one middle, one last column. */
const UNCOUNTED: ReadonlySet<Motion> = new Set(["home", "end", "last-col", "screen-middle"]);

/** The keys that wait for a second: g, z, m, the marks, y, the brackets and c. */
const WAITING: ReadonlySet<string> = new Set(["g", "z", "m", "'", "`", "y", "]", "[", "c"]);

const CTRL_MOTIONS: ReadonlyMap<string, Motion> = new Map([
  ["d", "half-down"],
  ["u", "half-up"],
  ["f", "page-down"],
  ["b", "page-up"],
]);

/** moved is a motion with its count, where the motion takes one. */
function moved(motion: Motion, count: number | undefined): Step {
  return done(move(motion, UNCOUNTED.has(motion) ? undefined : count));
}

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
    // Shift in a chord names another key: Ctrl+Shift+B is the panel's, and
    // read as Ctrl+b it would page up under it. CapsLock is why the case of
    // the letter itself says nothing.
    if (press.shift) return undefined;
    // Redo, which is why the reload item gave up Ctrl+R.
    if (key.toLowerCase() === "r") return done(change(mode, press, { t: "redo" }));
    const motion = CTRL_MOTIONS.get(key.toLowerCase());
    return motion === undefined ? undefined : moved(motion, count);
  }

  if (key === "Escape") {
    // Pending keys first. Someone who types 4 by mistake and presses Esc means
    // "cancel the 4", not "lock the file".
    if (showing(pending) !== "") return done(NONE);
    return done(mode === "transform" ? { t: "mode", to: "view" } : { t: "say", text: "" });
  }
  const named = NAMED_MOTIONS.get(key);
  if (named !== undefined) return moved(named, count);
  // The next cell, and with Shift the one before, as every spreadsheet has it.
  if (key === "Tab") return moved(press.shift ? "left" : "right", count);
  if (key === "Enter" || key === "F2") return done(open(mode, "all"));

  // A named key that types nothing: Shift, CapsLock, a dead key.
  if (!isCharacter(key)) return undefined;

  if (pending.keys !== "") return done(finish(mode, press, pending.keys + key, count));

  // 0 is a digit once a count has started, as in 10j, and a motion otherwise.
  if ((key >= "1" && key <= "9") || (key === "0" && pending.count !== "")) {
    const digits = pending.count.length < COUNT_DIGITS ? pending.count + key : pending.count;
    return { pending: { count: digits, keys: "" }, action: NONE };
  }

  const letter = LETTER_MOTIONS.get(key);
  if (letter !== undefined) return moved(letter, count);
  if (WAITING.has(key)) return { pending: { count: pending.count, keys: key }, action: NONE };
  if (isLead(key)) return done({ t: "prompt", lead: key });

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
    case "gt":
      return { t: "tab", step: 1, count };
    case "gT":
      return { t: "tab", step: -1, count };
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

/**
 * editorKey ends the insert on Enter and on Esc, and both keep the typing. Vim
 * users press Esc at the end of every insert, and losing the text each time
 * would make the keys useless. A value that did not change records nothing.
 */
function editorKey(key: string, composing: boolean): EditorKey {
  if (composing || key === "Process") return undefined;
  return key === "Enter" || key === "Escape" ? "commit" : undefined;
}

/** open is a key that opens the editor, which view refuses. */
function open(mode: Mode, caret: Caret): Action {
  return mode === "view"
    ? { t: "say", text: m.locked_vim() }
    : { t: "insert", caret, transform: false };
}

/**
 * change is a key that writes. View refuses it, and a held key does nothing:
 * holding j should scroll, and holding u should not empty the log.
 */
function change(mode: Mode, press: Press, action: Action): Action {
  if (press.repeat) return NONE;
  return mode === "view" ? { t: "say", text: m.locked_vim() } : action;
}

export const vimStyle: InputStrategy = {
  name: "vim-style",
  get locked() {
    return m.locked_vim();
  },
  // Transform with the editor open, which is vim's insert mode.
  get editing() {
    return m.mode_insert();
  },
  get switchHint() {
    return m.switch_hint_vim();
  },
  interpret,
  editorKey,
};
