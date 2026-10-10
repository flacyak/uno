// Default input: spreadsheet keys.
//
// Arrows, Tab, Shift+Tab and the page keys move. Enter and F2 open the editor
// on the value. Typing a character opens the editor with that character. In
// the editor Enter commits, Esc cancels, and Tab commits then moves. Ctrl+C
// yanks and Ctrl+R redoes. Ctrl+E and Ctrl+Z are handled by the shell.

import { NAMED_MOTIONS, NONE, done, isCharacter, move } from "../keys.ts";
import type { Action, Mode, Pending, Press, Step } from "../keys.ts";
import { m } from "../../paraglide/messages.js";
import type { EditorKey, InputStrategy } from "./strategy.ts";

/** Chord that switches between view and transform. Shown as the switch
 * hint. */
const SWITCH_KEY = "Ctrl+E";

/** Interprets one key press. Every key acts on its own, so pending keys
 * are ignored. */
function interpret(mode: Mode, _pending: Pending, press: Press): Step | undefined {
  if (press.alt || press.meta) return undefined;
  const key = press.key;

  if (press.ctrl) {
    // Ctrl+Shift chords belong to the shell. Lower-cased because CapsLock
    // changes the letter's case.
    if (press.shift) return undefined;
    switch (key.toLowerCase()) {
      case "c":
        // Allowed in view mode.
        return done({ t: "yank" });
      case "r":
        // Ignored on key repeat.
        return done(press.repeat ? NONE : writes(mode, { t: "redo" }));
    }
    return undefined;
  }

  const named = NAMED_MOTIONS.get(key);
  if (named !== undefined) return done(move(named, undefined));
  // Tab moves right, Shift+Tab moves left.
  if (key === "Tab") return done(move(press.shift ? "left" : "right", undefined));
  if (key === "Enter" || key === "F2") {
    return done(writes(mode, { t: "insert", caret: "all", transform: false }));
  }

  // Named keys such as Esc and Shift are left alone.
  if (!isCharacter(key)) return undefined;

  // A typed character opens the editor with that character as the value.
  return done(writes(mode, { t: "insert", caret: "empty", transform: false, text: key }));
}

/** Enter commits, Esc cancels. */
function editorKey(key: string, composing: boolean): EditorKey {
  if (composing || key === "Process") return undefined;
  if (key === "Enter") return "commit";
  return key === "Escape" ? "cancel" : undefined;
}

/** Returns `action` in transform mode. In view mode returns a message
 * saying the file is locked. */
function writes(mode: Mode, action: Action): Action {
  return mode === "view" ? { t: "say", text: m.locked_default() } : action;
}

export const defaultInput: InputStrategy = {
  name: "default",
  get locked() {
    return m.locked_default();
  },
  // The status bar keeps the transform label while the editor is open.
  editing: undefined,
  switchHint: SWITCH_KEY,
  interpret,
  editorKey,
};
