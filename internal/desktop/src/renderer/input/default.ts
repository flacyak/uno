// Default input: the keys a spreadsheet has.
//
// The arrows, Tab and the page keys move. Enter, F2 or a double click open the
// editor on the value, typing over a cell replaces it, and in the editor Enter
// keeps the typing and Esc throws it away. Ctrl+C copies the cell and Ctrl+R
// records again what Ctrl+Z took back. Ctrl+E and Ctrl+Z are the shell's, and
// work the same whichever strategy reads the grid's keys.

import { NOTHING, isCharacter } from "../keys.ts";
import type { Action, Mode, Motion, Pending, Press, Step } from "../keys.ts";
import type { EditorKey, InputStrategy } from "./strategy.ts";

const LOCKED = "View · Ctrl+E to transform";

const NONE: Action = { t: "none" };

/** interpret reads one key in view or transform. Nothing waits for a second key, so nothing is pending. */
function interpret(mode: Mode, _pending: Pending, press: Press): Step | undefined {
  if (press.alt || press.meta) return undefined;
  const key = press.key;

  if (press.ctrl) {
    switch (key.toLowerCase()) {
      case "c":
        // Copying changes nothing, so view allows it.
        return done({ t: "yank" });
      case "r":
        // A held Ctrl+R should not record the whole of what was taken back.
        return done(press.repeat ? NONE : writes(mode, { t: "redo" }));
    }
    return undefined;
  }

  switch (key) {
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
      return done(writes(mode, { t: "insert", caret: "all", transform: false }));
  }

  // Esc, Shift and every other key that types nothing are not the grid's.
  if (!isCharacter(key)) return undefined;

  // Typing over a cell replaces it, which is what every spreadsheet does.
  return done(writes(mode, { t: "insert", caret: "empty", transform: false, text: key }));
}

/** editorKey keeps the typing on Enter and throws it away on Esc. */
function editorKey(key: string, composing: boolean): EditorKey {
  if (composing || key === "Process") return undefined;
  if (key === "Enter") return "commit";
  return key === "Escape" ? "cancel" : undefined;
}

function done(action: Action): Step {
  return { pending: NOTHING, action };
}

function move(motion: Motion): Action {
  return { t: "move", motion, count: undefined };
}

/** writes is a key that changes the file, which view refuses by saying what would. */
function writes(mode: Mode, action: Action): Action {
  return mode === "view" ? { t: "say", text: LOCKED } : action;
}

export const defaultInput: InputStrategy = {
  name: "default",
  locked: LOCKED,
  // The editor is open in transform, and the status bar goes on saying so.
  editing: undefined,
  switchHint: "Ctrl+E",
  interpret,
  editorKey,
};
