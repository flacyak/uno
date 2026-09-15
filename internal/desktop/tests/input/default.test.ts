// Default input without a window: the keys a spreadsheet has.

import { expect, test } from "vite-plus/test";

import { defaultInput } from "../../src/renderer/input/default.ts";
import { strategy } from "../../src/renderer/input/index.ts";
import { vimStyle } from "../../src/renderer/input/vim-style.ts";
import { NOTHING } from "../../src/renderer/keys.ts";
import type { Action, Mode, Press } from "../../src/renderer/keys.ts";

const LOCKED = defaultInput.locked;

function key(name: string, more: Partial<Press> = {}): Press {
  return { key: name, ctrl: false, alt: false, meta: false, repeat: false, ...more };
}

function action(mode: Mode, press: Press): Action | undefined {
  return defaultInput.interpret(mode, NOTHING, press)?.action;
}

test("typing over a cell replaces it in transform, and says why not in view", () => {
  const typed = (text: string) => ({ t: "insert", caret: "empty", transform: false, text });
  expect(action("transform", key("9"))).toEqual(typed("9"));
  expect(action("transform", key("j")), "a letter is a value, not a command").toEqual(typed("j"));
  expect(action("view", key("9"))).toEqual({ t: "say", text: LOCKED });
});

test("Enter and F2 open the editor on the whole value", () => {
  const all = { t: "insert", caret: "all", transform: false };
  expect(action("transform", key("Enter"))).toEqual(all);
  expect(action("transform", key("F2"))).toEqual(all);
  expect(action("view", key("Enter"))).toEqual({ t: "say", text: LOCKED });
});

test("the arrows, Tab, PgUp, PgDn, Home and End move, one step at a time", () => {
  const move = (motion: string) => ({ t: "move", motion, count: undefined });
  expect(action("view", key("ArrowDown"))).toEqual(move("down"));
  expect(action("view", key("Tab"))).toEqual(move("right"));
  expect(action("transform", key("PageUp"))).toEqual(move("page-up"));
  expect(action("transform", key("End"))).toEqual(move("end"));
});

test("Ctrl+C copies in either mode, and Ctrl+R redoes in transform only", () => {
  expect(action("view", key("c", { ctrl: true }))).toEqual({ t: "yank" });
  expect(action("transform", key("c", { ctrl: true }))).toEqual({ t: "yank" });
  expect(action("transform", key("r", { ctrl: true }))).toEqual({ t: "redo" });
  expect(action("view", key("r", { ctrl: true }))).toEqual({ t: "say", text: LOCKED });
  expect(action("transform", key("r", { ctrl: true, repeat: true })), "held").toEqual({
    t: "none",
  });
});

test("Esc, the shell's chords and keys that type nothing are not the grid's", () => {
  for (const press of [
    key("Escape"),
    key("e", { ctrl: true }),
    key("z", { ctrl: true }),
    key("Shift"),
    key("a", { alt: true }),
  ]) {
    expect(defaultInput.interpret("transform", NOTHING, press), press.key).toBeUndefined();
  }
});

test("in the editor Enter keeps the typing and Esc throws it away", () => {
  expect(defaultInput.editorKey("Enter", false)).toBe("commit");
  expect(defaultInput.editorKey("Escape", false)).toBe("cancel");
  expect(defaultInput.editorKey("Escape", true), "an input method composing").toBeUndefined();
  expect(defaultInput.editorKey("Process", false)).toBeUndefined();
});

test("a name picks its strategy, and anything else is the default", () => {
  expect(strategy("vim-style")).toBe(vimStyle);
  expect(strategy("default")).toBe(defaultInput);
  expect(strategy(null), "nothing saved yet").toBe(defaultInput);
  expect(strategy("emacs"), "a name a later build saved").toBe(defaultInput);
});
