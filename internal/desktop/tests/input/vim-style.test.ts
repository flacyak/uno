// Vim-style input without a window: a mode, what is pending, and a key in; the
// next pending keys and one action out.

import { expect, test } from "vite-plus/test";

import { vimStyle } from "../../src/renderer/input/vim-style.ts";
import { NOTHING, showing } from "../../src/renderer/keys.ts";
import type { Action, Mode, Pending, Press, Step } from "../../src/renderer/keys.ts";

const LOCKED = vimStyle.locked;

/**
 * press reads a run of keys. A key that is not a character is written `<Name>`,
 * and a Ctrl chord `<C-d>`.
 */
function press(mode: Mode, keys: string, from: Pending = NOTHING): Step {
  let step: Step = { pending: from, action: { t: "none" } };
  for (const p of split(keys)) {
    const next = vimStyle.interpret(mode, step.pending, p);
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
  // Letters are commands, so j and 9 do not start a value the way they would by default.
  for (const key of ["j", "9", "x", " "]) {
    expect(action("transform", key).t, key).not.toBe("insert");
  }
});

test("u undoes in transform, says why not in view, and does nothing held down", () => {
  expect(action("transform", "u")).toEqual({ t: "undo" });
  expect(action("view", "u")).toEqual({ t: "say", text: LOCKED });
  expect(vimStyle.interpret("transform", NOTHING, held("u"))?.action).toEqual({ t: "none" });
});

test("Ctrl+r redoes in transform, says why not in view, and does nothing held down", () => {
  expect(action("transform", "<C-r>")).toEqual({ t: "redo" });
  expect(action("view", "<C-r>")).toEqual({ t: "say", text: LOCKED });
  const holding = { key: "r", ctrl: true, alt: false, meta: false, repeat: true };
  expect(vimStyle.interpret("transform", NOTHING, holding)?.action).toEqual({ t: "none" });
});

test("x and p change the cell in transform only, and do nothing held down", () => {
  expect(action("transform", "x")).toEqual({ t: "clear" });
  expect(action("transform", "p")).toEqual({ t: "put" });
  expect(action("transform", "P")).toEqual({ t: "put" });
  expect(action("view", "x")).toEqual({ t: "say", text: LOCKED });
  expect(action("view", "P")).toEqual({ t: "say", text: LOCKED });
  expect(vimStyle.interpret("transform", NOTHING, held("x"))?.action).toEqual({ t: "none" });
  expect(vimStyle.interpret("transform", NOTHING, held("p"))?.action).toEqual({ t: "none" });
});

test("yy copies in view as well, because copying changes nothing", () => {
  expect(action("view", "yy")).toEqual({ t: "yank" });
  expect(action("transform", "3yy")).toEqual({ t: "yank" });
  expect(press("view", "yj")).toEqual({ pending: NOTHING, action: { t: "none" } });
});

test(". repeats in transform only, and does nothing held down", () => {
  expect(action("transform", ".")).toEqual({ t: "repeat" });
  expect(action("view", ".")).toEqual({ t: "say", text: LOCKED });
  expect(vimStyle.interpret("transform", NOTHING, held("."))?.action).toEqual({ t: "none" });
});

test("ga applies the banner's offer and gx says not now, in transform only", () => {
  expect(action("transform", "ga")).toEqual({ t: "apply" });
  expect(action("transform", "gx")).toEqual({ t: "dismiss" });
  expect(action("view", "ga")).toEqual({ t: "say", text: LOCKED });
  expect(action("view", "gx")).toEqual({ t: "say", text: LOCKED });

  const g = { count: "", keys: "g" };
  expect(vimStyle.interpret("transform", g, held("a"))?.action, "a held after g").toEqual({
    t: "none",
  });
});

test(": opens the command line in either mode, and drops a count", () => {
  expect(action("view", ":")).toEqual({ t: "prompt", lead: ":" });
  expect(press("transform", "3:")).toEqual({
    pending: NOTHING,
    action: { t: "prompt", lead: ":" },
  });
});

test("]f and [f look down and up the column, in either mode", () => {
  expect(action("view", "]f")).toEqual({ t: "unparsed", dir: 1 });
  expect(action("transform", "[f")).toEqual({ t: "unparsed", dir: -1 });
  expect(showing(press("view", "]").pending)).toBe("]");
  expect(press("view", "]x")).toEqual({ pending: NOTHING, action: { t: "none" } });
});

test("/ and ? open a search down and up, and n and N search again", () => {
  expect(action("view", "/")).toEqual({ t: "prompt", lead: "/" });
  expect(action("transform", "?")).toEqual({ t: "prompt", lead: "?" });
  expect(action("view", "n")).toEqual({ t: "next", reverse: false });
  expect(action("transform", "N")).toEqual({ t: "next", reverse: true });
});

test("the arrows, Tab, PgUp, PgDn, Home and End keep working", () => {
  expect(action("view", "<ArrowDown>")).toEqual({ t: "move", motion: "down" });
  expect(action("view", "<Tab>")).toEqual({ t: "move", motion: "right" });
  expect(action("transform", "<PageUp>")).toEqual({ t: "move", motion: "page-up" });
  expect(action("transform", "<End>")).toEqual({ t: "move", motion: "end" });
});

test("chords and keys that type nothing are not the grid's, and keep what is pending", () => {
  const waiting = { count: "5", keys: "" };
  const base = { ctrl: false, alt: false, meta: false, repeat: false };
  expect(vimStyle.interpret("transform", waiting, { ...base, key: "Shift" })).toBeUndefined();
  expect(
    vimStyle.interpret("transform", waiting, { ...base, key: "e", ctrl: true }),
  ).toBeUndefined();
  expect(
    vimStyle.interpret("transform", waiting, { ...base, key: "s", meta: true }),
  ).toBeUndefined();
  expect(
    vimStyle.interpret("transform", waiting, { ...base, key: "a", alt: true }),
  ).toBeUndefined();
});

test("Enter and Esc both keep the typing, except while an input method is composing", () => {
  expect(vimStyle.editorKey("Escape", false)).toBe("commit");
  expect(vimStyle.editorKey("Enter", false)).toBe("commit");
  expect(vimStyle.editorKey("Escape", true)).toBeUndefined();
  expect(vimStyle.editorKey("Process", false)).toBeUndefined();
  expect(vimStyle.editorKey("j", false)).toBeUndefined();
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
  expect(action("transform", "3x"), "3x would record a set per cell").toEqual({ t: "clear" });
});

test("m sets a mark, ' and ` go to it, and '' goes back", () => {
  expect(action("view", "mq")).toEqual({ t: "mark", name: "q" });
  expect(action("transform", "'q")).toEqual({ t: "to-mark", name: "q" });
  expect(action("view", "`q")).toEqual({ t: "to-mark", name: "q" });
  expect(action("view", "''")).toEqual({ t: "back" });
  expect(action("view", "``")).toEqual({ t: "back" });
  expect(showing(press("view", "m").pending)).toBe("m");

  // A mark is a lowercase letter. Anything else drops the m.
  expect(press("view", "mQ")).toEqual({ pending: NOTHING, action: { t: "none" } });
  expect(press("view", "'1")).toEqual({ pending: NOTHING, action: { t: "none" } });
});

test("M, zz, zt and zb take no count", () => {
  expect(action("view", "3M")).toEqual({ t: "move", motion: "screen-middle", count: undefined });
  expect(action("view", "zz")).toEqual({ t: "scroll", where: "middle" });
  expect(action("view", "zt")).toEqual({ t: "scroll", where: "top" });
  expect(press("transform", "5zb")).toEqual({
    pending: NOTHING,
    action: { t: "scroll", where: "bottom" },
  });
});
