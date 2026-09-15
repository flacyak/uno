// The grid's keys without a window: a mode, what is pending, and a key in; the
// next pending keys and one action out. Then where each motion lands.

import { expect, test } from "vite-plus/test";

import { LOCKED, NOTHING, interpret, leavesInsert, showing, target } from "../src/renderer/keys.ts";
import type { Action, Mode, Pending, Place, Press, Step } from "../src/renderer/keys.ts";

/**
 * press reads a run of keys. A key that is not a character is written `<Name>`,
 * and a Ctrl chord `<C-d>`.
 */
function press(mode: Mode, keys: string, from: Pending = NOTHING): Step {
  let step: Step = { pending: from, action: { t: "none" } };
  for (const p of split(keys)) {
    const next = interpret(mode, step.pending, p);
    if (next === undefined) throw new Error(`${p.key} was not the grid's`);
    step = next;
  }
  return step;
}

function split(keys: string): Press[] {
  const base = { ctrl: false, alt: false, meta: false, repeat: false };
  return (keys.match(/<[^>]+>|./gu) ?? []).map((k) => {
    if (!k.startsWith("<")) return { ...base, key: k };
    const name = k.slice(1, -1);
    return name.startsWith("C-")
      ? { ...base, key: name.slice(2), ctrl: true }
      : { ...base, key: name };
  });
}

function action(mode: Mode, keys: string): Action {
  return press(mode, keys).action;
}

const held = (key: string): Press => ({ key, ctrl: false, alt: false, meta: false, repeat: true });

// ------------------------------------------------------------------ modes

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
  expect(press("transform", "c")).toEqual({
    pending: { count: "", keys: "c" },
    action: { t: "none" },
  });
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
  expect(press("transform", "4<Escape>")).toEqual({ pending: NOTHING, action: { t: "none" } });
  expect(action("transform", "<Escape>")).toEqual({ t: "mode", to: "view" });
  expect(action("view", "<Escape>")).toEqual({ t: "say", text: "" });
});

test("no key opens the editor holding itself", () => {
  // Type-to-replace is gone. j and 9 used to open the editor with themselves in it.
  for (const key of ["j", "9", "x", " "]) {
    expect(action("transform", key).t, key).not.toBe("insert");
  }
});

test("u undoes in transform, says why not in view, and does nothing held down", () => {
  expect(action("transform", "u")).toEqual({ t: "undo" });
  expect(action("view", "u")).toEqual({ t: "say", text: LOCKED });
  expect(interpret("transform", NOTHING, held("u"))?.action).toEqual({ t: "none" });
});

test("the keys that were there before keep working", () => {
  expect(action("view", "<ArrowDown>")).toEqual({ t: "move", motion: "down" });
  expect(action("view", "<Tab>")).toEqual({ t: "move", motion: "right" });
  expect(action("transform", "<PageUp>")).toEqual({ t: "move", motion: "page-up" });
  expect(action("transform", "<End>")).toEqual({ t: "move", motion: "end" });
});

test("chords and keys that type nothing are not the grid's, and keep what is pending", () => {
  const waiting = { count: "5", keys: "" };
  const base = { ctrl: false, alt: false, meta: false, repeat: false };
  expect(interpret("transform", waiting, { ...base, key: "Shift" })).toBeUndefined();
  expect(interpret("transform", waiting, { ...base, key: "e", ctrl: true })).toBeUndefined();
  expect(interpret("transform", waiting, { ...base, key: "s", meta: true })).toBeUndefined();
  expect(interpret("transform", waiting, { ...base, key: "a", alt: true })).toBeUndefined();
});

test("Enter and Esc leave insert, except while an input method is composing", () => {
  expect(leavesInsert("Escape", false)).toBe(true);
  expect(leavesInsert("Enter", false)).toBe(true);
  expect(leavesInsert("Escape", true)).toBe(false);
  expect(leavesInsert("Process", false)).toBe(false);
  expect(leavesInsert("j", false)).toBe(false);
});

// ----------------------------------------------------------------- counts

test("a count waits where the status bar can show it, and a motion takes it", () => {
  expect(showing(press("view", "12").pending)).toBe("12");
  expect(showing(press("view", "12g").pending)).toBe("12g");
  expect(press("view", "5j")).toEqual({
    pending: NOTHING,
    action: { t: "move", motion: "down", count: 5 },
  });
  expect(action("view", "5gg")).toEqual({ t: "move", motion: "first-row", count: 5 });
  expect(action("view", "<C-d>")).toEqual({ t: "move", motion: "half-down", count: undefined });
  expect(action("view", "3<C-f>")).toEqual({ t: "move", motion: "page-down", count: 3 });
});

test("0 is a digit once a count has started, and the first column otherwise", () => {
  expect(action("view", "0")).toEqual({ t: "move", motion: "first-col", count: undefined });
  expect(action("view", "10j")).toEqual({ t: "move", motion: "down", count: 10 });
});

test("a count before a change is dropped", () => {
  expect(press("transform", "3s")).toEqual({
    pending: NOTHING,
    action: { t: "insert", caret: "empty", transform: false },
  });
  expect(action("transform", "3u")).toEqual({ t: "undo" });
});

// ---------------------------------------------------------------- motions

/** A sheet of 4,812 rows and 6 columns, 20 rows to a page, fully indexed. */
function at(row: number, col: number, more: Partial<Place> = {}): Place {
  return { row, col, rows: 4812, cols: 6, readable: 4812, page: 20, ...more };
}

test("h j k l move by one or by the count, and clamp at the edges", () => {
  expect(target("down", 5, at(10, 2))).toEqual({ row: 15, col: 2 });
  expect(target("down", undefined, at(4811, 2))).toEqual({ row: 4811, col: 2 });
  expect(target("left", 9, at(10, 2))).toEqual({ row: 10, col: 0 });
  expect(target("right", 1, at(10, 5))).toEqual({ row: 10, col: 5 });
});

test("j moves exactly one row at row 50,000,000", () => {
  const huge = { rows: 60_000_000, readable: 60_000_000 };
  expect(target("down", undefined, at(49_999_999, 0, huge))).toEqual({ row: 50_000_000, col: 0 });
});

test("w and b read cells in order, across rows, and stop at either end", () => {
  expect(target("next", undefined, at(3, 5))).toEqual({ row: 4, col: 0 });
  expect(target("previous", undefined, at(4, 0))).toEqual({ row: 3, col: 5 });
  expect(target("next", 8, at(0, 0))).toEqual({ row: 1, col: 2 });
  expect(target("next", undefined, at(4811, 5))).toEqual({ row: 4811, col: 5 });
  expect(target("previous", undefined, at(0, 0))).toEqual({ row: 0, col: 0 });
});

test("0, ^ and $ go to the ends of the row", () => {
  expect(target("first-col", undefined, at(7, 4))).toEqual({ row: 7, col: 0 });
  expect(target("last-col", undefined, at(7, 1))).toEqual({ row: 7, col: 5 });
});

test("gg and G go to the first and last row, and with a count to row n", () => {
  expect(target("first-row", undefined, at(300, 3))).toEqual({ row: 0, col: 3 });
  expect(target("last-row", undefined, at(300, 3))).toEqual({ row: 4811, col: 3 });
  expect(target("first-row", 5, at(300, 3))).toEqual({ row: 4, col: 3 });
  expect(target("last-row", 5, at(300, 3))).toEqual({ row: 4, col: 3 });
  expect(target("last-row", 99_999, at(300, 3)), "past the end").toEqual({ row: 4811, col: 3 });
});

test("while the file indexes, G stops at the last row the engine can read and says so", () => {
  const indexing = { rows: 8_000_000, readable: 5_000_000 };
  expect(target("last-row", undefined, at(0, 1, indexing))).toEqual({
    row: 4_999_999,
    col: 1,
    short: "end",
  });
  expect(target("last-row", 6_000_000, at(0, 1, indexing))).toEqual({
    row: 4_999_999,
    col: 1,
    short: 5_999_999,
  });
  expect(target("last-row", 12, at(0, 1, indexing))).toEqual({ row: 11, col: 1 });
});

test("Ctrl+d and Ctrl+u move half a page, and at least a row", () => {
  expect(target("half-down", undefined, at(100, 0))).toEqual({ row: 110, col: 0 });
  expect(target("half-up", 2, at(100, 0))).toEqual({ row: 80, col: 0 });
  expect(target("half-down", undefined, at(100, 0, { page: 1 }))).toEqual({ row: 101, col: 0 });
  expect(target("page-down", undefined, at(100, 0))).toEqual({ row: 120, col: 0 });
});
