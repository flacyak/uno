/**
 * @fileoverview The grid over a plain DOM, driven as the shell drives it: rows
 * shown, keys pressed on the host, and what the selection, the marks, and the
 * editor do, the first two as a source finds columns. happy-dom skips layout,
 * so the scroller is told its height.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Kind } from "@sheet";

import { Grid } from "@renderer/grid";
import type { Column, GridEvents, Rows } from "@renderer/grid/rows";
import { defaultInput } from "@renderer/input/default";
import type { InputStrategy } from "@renderer/input/strategy";
import { vimStyle } from "@renderer/input/vim-style";
import { m } from "@paraglide/messages";

/** The header height the grid is told, since happy-dom skips layout. */
const HEAD_H = 30;
const VIEWPORT = 600;

/** A sheet of `total` rows and `cols` columns. Each cell's text is its coordinates. */
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

/** Filed is a sheet whose last column is supplied, as _file is, and the columns it finds. */
interface Filed {
  readonly rows: Rows;
  /** Puts a column in before the supplied one, as a file found as it is indexed does. */
  find(header: string): void;
}

/** filed returns a sheet of `total` rows over an id and a supplied _file. */
function filed(total: number): Filed {
  const columnOf = (header: string): Column => ({ header, kind: "text", flagged: false });
  let columns = ["id", "_file"].map(columnOf);
  const rows: Rows = {
    get columns() {
      return columns;
    },
    rows: () => total,
    cols: () => columns.length,
    display: (row, col) => `${row},${col}`,
    raw: (row, col) => `${row},${col}`,
    binding: () => undefined,
  };
  return {
    rows,
    find: (header) => {
      columns = [...columns.slice(0, -1), columnOf(header), ...columns.slice(-1)];
    },
  };
}

interface Driven {
  grid: Grid;
  /** What the grid said, in order. */
  said: string[];
  /** The cells committed, in order. */
  edits: [row: number, col: number, value: string][];
  /** Sends a key to the grid, or to `target` in it, and returns the event. */
  press: (key: string, init?: KeyboardEventInit, target?: Element) => KeyboardEvent;
  /** The open cell editor. */
  editor: () => HTMLInputElement;
}

/** Builds a grid reading keys through `input`, on a scroller tall enough to draw rows. */
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

  // Show the other tab's rows, where mark a is unset.
  grid.show(second, false);
  press("'");
  press("a");
  expect(said.at(-1)).toBe(m.mark_not_set({ name: "a" }));
  expect(grid.selection()).toEqual({ row: 0, col: 0 });

  // Show the first tab again and restore its selection.
  grid.show(first, false);
  grid.moveTo(0, 0);
  press("'");
  press("a");
  expect(grid.selection(), "'a on the tab that set it").toEqual({ row: 7, col: 1 });
  press("'");
  press("'");
  expect(grid.selection(), "'' back from the jump").toEqual({ row: 0, col: 0 });
});

test("the selection and each mark move right with _file as its source finds columns, shown or not", () => {
  const { grid, press } = make(vimStyle);
  const file = filed(40);
  const FILE = 1;
  grid.show(file.rows, false);
  grid.moveTo(7, FILE);
  press("m");
  press("a");
  grid.moveTo(2, FILE);
  press("'");
  press("a");

  file.find("late");
  grid.refresh();
  expect(grid.selection(), "the selection on _file").toEqual({ row: 7, col: FILE + 1 });
  press("'");
  press("'");
  expect(grid.selection(), "'' back to where the jump left _file").toEqual({
    row: 2,
    col: FILE + 1,
  });

  // Found while another tab shows, a column moves the marks once the tab is back.
  grid.show(sheet(40), false);
  file.find("later");
  grid.show(file.rows, false);
  press("'");
  press("a");
  expect(grid.selection(), "'a on the tab that found it").toEqual({ row: 7, col: FILE + 2 });
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
