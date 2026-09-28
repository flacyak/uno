// @vitest-environment happy-dom
//
// The grid over a plain DOM, driven the way the shell drives it: rows shown,
// keys pressed on the host, and what the selection, the marks and the editor
// make of them. happy-dom lays nothing out, so the scroller is told how tall it
// is, as view.test.ts does.

import { expect, test } from "vite-plus/test";

import type { Kind } from "@uno/grid/sheet";

import { Grid } from "../../src/renderer/grid/index.ts";
import type { GridEvents, Rows } from "../../src/renderer/grid/rows.ts";
import { defaultInput } from "../../src/renderer/input/default.ts";
import type { InputStrategy } from "../../src/renderer/input/strategy.ts";
import { vimStyle } from "../../src/renderer/input/vim-style.ts";
import { m } from "../../src/paraglide/messages.js";

/** What the header is told it measures, since happy-dom measures nothing. */
const HEAD_H = 30;
const VIEWPORT = 600;

/** A sheet of `total` rows and `cols` columns, every cell its own coordinates. */
function sheet(total: number, cols = 3): Rows {
  const kind: Kind = "text";
  return {
    columns: Array.from({ length: cols }, (_, c) => ({ header: `c${c}`, kind, flagged: false })),
    rows: () => total,
    cols: () => cols,
    display: (row, col) => `${row},${col}`,
    raw: (row, col) => `${row},${col}`,
    binding: () => undefined,
  };
}

interface Driven {
  grid: Grid;
  /** What the grid said, in order. */
  said: string[];
  /** The cells committed, in order. */
  edits: [row: number, col: number, value: string][];
  /** press sends a key to the grid, or to `target` in it, and returns the event for what became of it. */
  press: (key: string, init?: KeyboardEventInit, target?: Element) => KeyboardEvent;
  /** The open cell editor. */
  editor: () => HTMLInputElement;
}

/** make builds a grid reading keys through `input`, on a scroller tall enough to draw rows. */
function make(input: InputStrategy): Driven {
  const host = document.createElement("div");
  host.tabIndex = 0;
  document.body.append(host);

  const said: string[] = [];
  const edits: Driven["edits"] = [];
  const events: GridEvents = {
    onSelect: () => undefined,
    onEdit: (row, col, value) => {
      edits.push([row, col, value]);
    },
    onSay: (text) => {
      said.push(text);
    },
    onMode: () => undefined,
    onEditor: () => undefined,
    onPending: () => undefined,
    onShort: () => undefined,
    onAction: () => undefined,
  };
  const grid = new Grid(host, events, input);

  const head = host.querySelector("thead");
  const scroller = host.querySelector(".grid-scroll");
  if (head === null || scroller === null) throw new Error("the grid did not build its table");
  Object.defineProperty(head, "offsetHeight", { value: HEAD_H });
  Object.defineProperty(scroller, "clientHeight", { value: VIEWPORT });

  const press: Driven["press"] = (key, init = {}, target = host) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  const editor = (): HTMLInputElement => {
    const input = host.querySelector("input.cell-editor");
    if (!(input instanceof HTMLInputElement)) throw new Error("the editor is not open");
    return input;
  };
  return { grid, said, edits, press, editor };
}

// ------------------------------------------------------------------ marks

test("a mark is its own tab's: it waits through a tab switch, and is not set on another", () => {
  const { grid, press, said } = make(vimStyle);
  const first = sheet(40);
  const second = sheet(40);
  grid.show(first, false);
  grid.moveTo(7, 1);
  press("m");
  press("a");

  // gt: the shell shows the other tab's rows, where a is nothing yet.
  grid.show(second, false);
  press("'");
  press("a");
  expect(said.at(-1)).toBe(m.mark_not_set({ name: "a" }));
  expect(grid.selection()).toEqual({ row: 0, col: 0 });

  // gT: the shell shows the first tab again, and puts its selection back.
  grid.show(first, false);
  grid.moveTo(0, 0);
  press("'");
  press("a");
  expect(grid.selection(), "'a on the tab that set it").toEqual({ row: 7, col: 1 });
  press("'");
  press("'");
  expect(grid.selection(), "'' back from the jump").toEqual({ row: 0, col: 0 });
});

// ----------------------------------------------------------------- editor

for (const input of [defaultInput, vimStyle]) {
  test(`${input.name}: Tab in the editor keeps the typing and goes on to the next cell, Shift+Tab to the one before`, () => {
    const { grid, press, editor, edits } = make(input);
    grid.show(sheet(40), true);
    grid.moveTo(2, 0);

    press("Enter");
    editor().value = "typed";
    const tab = press("Tab", {}, editor());
    expect(tab.defaultPrevented, "left to the field, Tab carries focus off the grid").toBe(true);
    expect(grid.editing()).toBe(false);
    expect(edits).toEqual([[2, 0, "typed"]]);
    expect(grid.selection()).toEqual({ row: 2, col: 1 });

    press("Enter");
    editor().value = "more";
    press("Tab", { shiftKey: true }, editor());
    expect(grid.editing()).toBe(false);
    expect(edits.at(-1)).toEqual([2, 1, "more"]);
    expect(grid.selection()).toEqual({ row: 2, col: 0 });
  });
}
