// The grid's keys without a window: a mode, what is pending, and a key in; the
// next pending keys and one action out.

import { expect, test } from "vite-plus/test";

import { LOCKED, NOTHING, interpret, leavesInsert } from "../src/renderer/keys.ts";
import type { Action, Mode, Pending, Step } from "../src/renderer/keys.ts";

/** press reads a run of keys, `<Esc>` style names for the ones that are not characters. */
function press(mode: Mode, keys: string, from: Pending = NOTHING): Step {
  let step: Step = { pending: from, action: { t: "none" } };
  for (const key of split(keys)) {
    const next = interpret(mode, step.pending, {
      key,
      ctrl: false,
      alt: false,
      meta: false,
      repeat: false,
    });
    if (next === undefined) throw new Error(`${key} was not the grid's`);
    step = next;
  }
  return step;
}

function split(keys: string): string[] {
  return keys.match(/<[^>]+>|./gu)?.map((k) => (k.startsWith("<") ? k.slice(1, -1) : k)) ?? [];
}

function action(mode: Mode, keys: string): Action {
  return press(mode, keys).action;
}

test("i in view stops at transform, and in transform opens the editor at the start", () => {
  expect(action("view", "i")).toEqual({ t: "mode", to: "transform" });
  expect(action("transform", "i")).toEqual({ t: "insert", caret: "start", transform: false });
  expect(action("view", "I")).toEqual(action("view", "i"));
  expect(action("transform", "I")).toEqual(action("transform", "i"));
});

test("a goes from view to appending in one key", () => {
  expect(action("view", "a")).toEqual({ t: "insert", caret: "end", transform: true });
  expect(action("transform", "a")).toEqual({ t: "insert", caret: "end", transform: false });
  expect(action("view", "A")).toEqual(action("view", "a"));
});

test("s and cc open the editor empty in transform, and say why not in view", () => {
  const empty = { t: "insert", caret: "empty", transform: false };
  expect(action("transform", "s")).toEqual(empty);
  expect(action("transform", "cc")).toEqual(empty);

  const locked = { t: "say", text: LOCKED };
  expect(action("view", "s")).toEqual(locked);
  expect(action("view", "cc")).toEqual(locked);
});

test("the first c waits for the second, and anything else drops it", () => {
  expect(press("transform", "c")).toEqual({ pending: { keys: "c" }, action: { t: "none" } });
  expect(press("transform", "cx")).toEqual({ pending: NOTHING, action: { t: "none" } });
});

test("Enter and F2 open the editor on the whole value", () => {
  const all = { t: "insert", caret: "all", transform: false };
  expect(action("transform", "<Enter>")).toEqual(all);
  expect(action("transform", "<F2>")).toEqual(all);
  expect(action("view", "<Enter>")).toEqual({ t: "say", text: LOCKED });
});

test("Esc drops pending keys first, then leaves transform, then clears the message", () => {
  expect(press("transform", "c<Escape>")).toEqual({ pending: NOTHING, action: { t: "none" } });
  expect(action("transform", "<Escape>")).toEqual({ t: "mode", to: "view" });
  expect(action("view", "<Escape>")).toEqual({ t: "say", text: "" });
});

test("a letter is a command, never the start of a value", () => {
  // Type-to-replace is gone. j and 9 used to open the editor holding themselves.
  for (const key of ["j", "9", "x", " "]) {
    expect(action("transform", key), key).toEqual({ t: "none" });
  }
});

test("u undoes in transform, says why not in view, and does nothing held down", () => {
  expect(action("transform", "u")).toEqual({ t: "undo" });
  expect(action("view", "u")).toEqual({ t: "say", text: LOCKED });

  const held = { key: "u", ctrl: false, alt: false, meta: false, repeat: true };
  expect(interpret("transform", NOTHING, held)?.action).toEqual({ t: "none" });
});

test("the keys that were there before keep working", () => {
  expect(action("view", "<ArrowDown>")).toEqual({ t: "move", motion: "down" });
  expect(action("view", "<Tab>")).toEqual({ t: "move", motion: "right" });
  expect(action("transform", "<PageUp>")).toEqual({ t: "move", motion: "page-up" });
  expect(action("transform", "<End>")).toEqual({ t: "move", motion: "end" });
});

test("chords and keys that type nothing are not the grid's, and keep what is pending", () => {
  const c = { keys: "c" };
  const base = { ctrl: false, alt: false, meta: false, repeat: false };
  expect(interpret("transform", c, { ...base, key: "Shift" })).toBeUndefined();
  expect(interpret("transform", c, { ...base, key: "e", ctrl: true })).toBeUndefined();
  expect(interpret("transform", c, { ...base, key: "s", meta: true })).toBeUndefined();
  expect(interpret("transform", c, { ...base, key: "a", alt: true })).toBeUndefined();
});

test("Enter and Esc leave insert, except while an input method is composing", () => {
  expect(leavesInsert("Escape", false)).toBe(true);
  expect(leavesInsert("Enter", false)).toBe(true);
  expect(leavesInsert("Escape", true)).toBe(false);
  expect(leavesInsert("Process", false)).toBe(false);
  expect(leavesInsert("j", false)).toBe(false);
});
