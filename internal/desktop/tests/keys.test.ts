// What keys mean, whichever strategy read them: where each motion lands, what .
// makes again, and what the command line reads.

import { expect, test } from "vite-plus/test";

import { changeOf, command, isJump, replay, target } from "../src/renderer/keys.ts";
import type { Place } from "../src/renderer/keys.ts";

// ----------------------------------------------------------------- repeat

test(". appends what a added at the end, and prepends what i added at the start", () => {
  // The recogniser's opening: 12 should read 12.00, and so should the next row.
  const append = changeOf("end", "12", "12.00");
  expect(append).toEqual({ t: "append", text: ".00" });
  expect(replay(append, "7")).toBe("7.00");

  const prepend = changeOf("start", "12", "$12");
  expect(prepend).toEqual({ t: "prepend", text: "$" });
  expect(replay(prepend, "7")).toBe("$7");
});

test(". sets the whole value after any other insert", () => {
  expect(changeOf("end", "12", "1x2"), "a change in the middle").toEqual({
    t: "set",
    value: "1x2",
  });
  expect(changeOf("start", "12", "12$"), "i, then the end").toEqual({ t: "set", value: "12$" });
  expect(changeOf("empty", "12", "13"), "s").toEqual({ t: "set", value: "13" });
  expect(changeOf("all", "12", "12.00"), "Enter").toEqual({ t: "set", value: "12.00" });
  expect(replay({ t: "set", value: "13" }, "7")).toBe("13");
});

// ----------------------------------------------------------- command line

test("the command line reads :w, :sav, :e, :e! and a row number", () => {
  expect(command("w")).toEqual({ t: "write" });
  expect(command(" write ")).toEqual({ t: "write" });
  expect(command("sav")).toEqual({ t: "save-as" });
  expect(command("e")).toEqual({ t: "open", force: false });
  expect(command("e!")).toEqual({ t: "open", force: true });
  expect(command("5000000")).toEqual({ t: "row", row: 5_000_000 });
  expect(command("")).toEqual({ t: "none" });
  expect(command("q"), "closing is the window's job").toEqual({ t: "unknown", text: "q" });
  expect(command("foo")).toEqual({ t: "unknown", text: "foo" });
});

// ---------------------------------------------------------------- motions

/** The sheet `at` places the selection in: fully indexed, with the first page on screen. */
const ROWS = 4812;
const COLS = 6;
const PAGE = 20;
const LAST_ROW = ROWS - 1;
const LAST_COL = COLS - 1;

function at(row: number, col: number, more: Partial<Place> = {}): Place {
  const screen = { top: 0, bottom: PAGE - 1 };
  return { row, col, rows: ROWS, cols: COLS, readable: ROWS, page: PAGE, ...screen, ...more };
}

test("h j k l move by one or by the count, and clamp at the edges", () => {
  expect(target("down", 5, at(10, 2))).toEqual({ row: 15, col: 2 });
  expect(target("down", undefined, at(LAST_ROW, 2))).toEqual({ row: LAST_ROW, col: 2 });
  expect(target("left", 9, at(10, 2))).toEqual({ row: 10, col: 0 });
  expect(target("right", 1, at(10, LAST_COL))).toEqual({ row: 10, col: LAST_COL });
});

test("j moves exactly one row at row 50,000,000", () => {
  const huge = { rows: 60_000_000, readable: 60_000_000 };
  expect(target("down", undefined, at(49_999_999, 0, huge))).toEqual({ row: 50_000_000, col: 0 });
});

test("w and b read cells in order, across rows, and stop at either end", () => {
  expect(target("next", undefined, at(3, LAST_COL))).toEqual({ row: 4, col: 0 });
  expect(target("previous", undefined, at(4, 0))).toEqual({ row: 3, col: LAST_COL });
  expect(target("next", COLS + 2, at(0, 0))).toEqual({ row: 1, col: 2 });
  const end = { row: LAST_ROW, col: LAST_COL };
  expect(target("next", undefined, at(end.row, end.col))).toEqual(end);
  expect(target("previous", undefined, at(0, 0))).toEqual({ row: 0, col: 0 });
});

test("0, ^ and $ go to the ends of the row", () => {
  expect(target("first-col", undefined, at(7, 4))).toEqual({ row: 7, col: 0 });
  expect(target("last-col", undefined, at(7, 1))).toEqual({ row: 7, col: LAST_COL });
});

test("gg and G go to the first and last row, and with a count to row n", () => {
  expect(target("first-row", undefined, at(300, 3))).toEqual({ row: 0, col: 3 });
  expect(target("last-row", undefined, at(300, 3))).toEqual({ row: LAST_ROW, col: 3 });
  expect(target("first-row", 5, at(300, 3))).toEqual({ row: 4, col: 3 });
  expect(target("last-row", 5, at(300, 3))).toEqual({ row: 4, col: 3 });
  expect(target("last-row", ROWS + 1, at(300, 3)), "past the end").toEqual({
    row: LAST_ROW,
    col: 3,
  });
});

test("while the file indexes, G stops at the last row the engine can read and says so", () => {
  const indexing = { rows: 8_000_000, readable: 5_000_000 };
  const readableEnd = indexing.readable - 1;
  expect(target("last-row", undefined, at(0, 1, indexing))).toEqual({
    row: readableEnd,
    col: 1,
    short: "end",
  });
  const unread = 6_000_000;
  expect(target("last-row", unread, at(0, 1, indexing))).toEqual({
    row: readableEnd,
    col: 1,
    short: unread - 1,
  });
  expect(target("last-row", 12, at(0, 1, indexing))).toEqual({ row: 11, col: 1 });
});

test("Ctrl+d and Ctrl+u move half a page, and at least a row", () => {
  const half = PAGE / 2;
  expect(target("half-down", undefined, at(100, 0))).toEqual({ row: 100 + half, col: 0 });
  expect(target("half-up", 2, at(100, 0))).toEqual({ row: 100 - 2 * half, col: 0 });
  expect(target("half-down", undefined, at(100, 0, { page: 1 }))).toEqual({ row: 101, col: 0 });
  expect(target("page-down", undefined, at(100, 0))).toEqual({ row: 100 + PAGE, col: 0 });
});

test("H, M and L land on the rows on screen, and a count counts in from the edge", () => {
  const screen = { top: 100, bottom: 119 };
  expect(target("screen-top", undefined, at(300, 2, screen))).toEqual({ row: 100, col: 2 });
  expect(target("screen-top", 3, at(300, 2, screen))).toEqual({ row: 102, col: 2 });
  expect(target("screen-bottom", 3, at(300, 2, screen))).toEqual({ row: 117, col: 2 });
  expect(target("screen-middle", undefined, at(300, 2, screen))).toEqual({ row: 109, col: 2 });
  expect(target("screen-top", 50, at(300, 2, screen)), "never off the screen").toEqual({
    row: 119,
    col: 2,
  });
});

test("G, gg, H, M and L are jumps, and a step is not", () => {
  for (const m of [
    "first-row",
    "last-row",
    "screen-top",
    "screen-middle",
    "screen-bottom",
  ] as const) {
    expect(isJump(m), m).toBe(true);
  }
  for (const m of ["down", "next", "last-col", "half-down", "end"] as const) {
    expect(isJump(m), m).toBe(false);
  }
});
