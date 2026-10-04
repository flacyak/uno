// Vim-style input.
//
// View and transform act as normal mode, with writes refused in view, and
// the cell editor acts as insert mode. `i` moves one level in and Esc moves
// one level out.

import { m } from "../../paraglide/messages.js";
import { NAMED_MOTIONS, NONE, done, isCharacter, isLead, move, showing } from "../keys.ts";
import type { Action, Caret, Mode, Motion, Pending, Press, Step } from "../keys.ts";
import type { EditorKey, InputStrategy } from "./strategy.ts";

/** Maximum digits in a count prefix. Further digits are dropped. */
const COUNT_DIGITS = 10;

/** Valid mark names. */
const MARK = /^[a-z]$/;

/** Single-key motions. `0` is a motion before a count has started. */
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

/** Motions that ignore a count. */
const UNCOUNTED: ReadonlySet<Motion> = new Set(["home", "end", "last-col", "screen-middle"]);

/** Keys that wait for a second key. */
const WAITING: ReadonlySet<string> = new Set(["g", "z", "m", "'", "`", "y", "]", "[", "c"]);

const CTRL_MOTIONS: ReadonlyMap<string, Motion> = new Map([
  ["d", "half-down"],
  ["u", "half-up"],
  ["f", "page-down"],
  ["b", "page-up"],
]);

/** Returns a move step. The count is dropped for motions in UNCOUNTED. */
function moved(motion: Motion, count: number | undefined): Step {
  return done(move(motion, UNCOUNTED.has(motion) ? undefined : count));
}

/**
 * Interprets one key press.
 *
 * A bare Shift returns undefined, which keeps a pending count. A
 * count applies to motions only. A count before any other key is dropped.
 */
function interpret(mode: Mode, pending: Pending, press: Press): Step | undefined {
  if (press.alt || press.meta) return undefined;
  const key = press.key;
  const count = pending.count === "" ? undefined : Number(pending.count);

  if (press.ctrl) {
    // Ctrl+Shift chords belong to the shell. Lower-cased because CapsLock
    // changes the letter's case.
    if (press.shift) return undefined;
    // Ctrl+R is redo.
    if (key.toLowerCase() === "r") return done(change(mode, press, { t: "redo" }));
    const motion = CTRL_MOTIONS.get(key.toLowerCase());
    return motion === undefined ? undefined : moved(motion, count);
  }

  if (key === "Escape") {
    // With pending keys, Esc only clears them.
    if (showing(pending) !== "") return done(NONE);
    return done(mode === "transform" ? { t: "mode", to: "view" } : { t: "say", text: "" });
  }
  const named = NAMED_MOTIONS.get(key);
  if (named !== undefined) return moved(named, count);
  // Tab moves right, Shift+Tab moves left.
  if (key === "Tab") return moved(press.shift ? "left" : "right", count);
  if (key === "Enter" || key === "F2") return done(open(mode, "all"));

  // Named keys such as Shift, CapsLock and dead keys are left alone.
  if (!isCharacter(key)) return undefined;

  if (pending.keys !== "") return done(finish(mode, press, pending.keys + key, count));

  // 0 is a digit once a count has started (10j) and a motion otherwise.
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
      // In view, i switches to transform. In transform, i opens the editor.
      return done(mode === "view" ? { t: "mode", to: "transform" } : open(mode, "start"));
    case "a":
    case "A":
      // a switches to transform if needed and opens the editor at the end.
      return done({ t: "insert", caret: "end", transform: mode === "view" });
    case "s":
      return done(open(mode, "empty"));
    case "u":
      return done(change(mode, press, { t: "undo" }));
    case "x":
      return done(change(mode, press, { t: "clear" }));
    case "p":
    case "P":
      // P and p do the same thing on a cell.
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

/** Interprets the second key of a two-key sequence. An unknown pair gives
 * NONE. */
function finish(mode: Mode, press: Press, keys: string, count: number | undefined): Action {
  const [first, second] = [keys.slice(0, 1), keys.slice(1)];
  if (first === "m") return MARK.test(second) ? { t: "mark", name: second } : NONE;
  // ' and ` both jump to the marked cell.
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

/** Enter and Esc both commit. An unchanged value leaves the cell and the
 * repeat record as they are. */
function editorKey(key: string, composing: boolean): EditorKey {
  if (composing || key === "Process") return undefined;
  return key === "Enter" || key === "Escape" ? "commit" : undefined;
}

/** Returns an insert action in transform mode. In view mode returns a
 * message saying the file is locked. */
function open(mode: Mode, caret: Caret): Action {
  return mode === "view"
    ? { t: "say", text: m.locked_vim() }
    : { t: "insert", caret, transform: false };
}

/** Returns `action` in transform mode. In view mode returns a message saying
 * the file is locked. Returns NONE on key repeat. */
function change(mode: Mode, press: Press, action: Action): Action {
  if (press.repeat) return NONE;
  return mode === "view" ? { t: "say", text: m.locked_vim() } : action;
}

export const vimStyle: InputStrategy = {
  name: "vim-style",
  get locked() {
    return m.locked_vim();
  },
  // Status bar label while the editor is open.
  get editing() {
    return m.mode_insert();
  },
  get switchHint() {
    return m.switch_hint_vim();
  },
  interpret,
  editorKey,
};
