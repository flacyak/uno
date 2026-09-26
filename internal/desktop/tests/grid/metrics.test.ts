// The grid's layout arithmetic, pulled out of View so it runs on a plain node
// with no display: how tall the scroller is, where the scrollbar maps to on a
// sheet past the cap, which rows the pool draws, and where a jump lands.

import { expect, test } from "vite-plus/test";

import {
  clampTop,
  firstRow,
  intoView,
  MAX_SCROLL_PX,
  measure,
  pageSize,
  poolSize,
  scrollerToTop,
  scrollTarget,
  tableOffset,
  topToScroller,
  visibleRange,
} from "../../src/renderer/grid/metrics.ts";

/** A row height taken from the stylesheet's default. */
const ROW_H = 29;

// -------------------------------------------------------------------- size

test("a sheet under the cap is not scaled, and its real height is its virtual one", () => {
  const m = measure(4812, ROW_H, 30, 600);
  expect(m.scaled).toBe(false);
  expect(m.real).toBe(4812 * ROW_H + 30);
});

test("a sheet past the cap is scaled, and its real height clamps to the cap", () => {
  const total = 600_000; // 600,000 * 29 + 30 = 17,400,030px, well past the cap
  const m = measure(total, ROW_H, 30, 600);
  expect(m.scaled).toBe(true);
  expect(m.real).toBe(MAX_SCROLL_PX);
});

test("vMax and rMax do not go negative when the viewport is taller than the sheet", () => {
  const m = measure(10, ROW_H, 30, 10_000);
  expect(m.vMax).toBe(0);
  expect(m.rMax).toBe(0);
});

// ---------------------------------------------------------------- mapping

test("a top mapped to the scrollbar and back lands where it started", () => {
  const vMax = 20_000_000;
  const rMax = 10_000_000; // a sheet scrolling at twice the scrollbar's rate
  for (const top of [0, vMax, vMax / 2]) {
    const scrollTop = topToScroller(top, vMax, rMax);
    expect(scrollerToTop(scrollTop, rMax, vMax), `top ${top}`).toBe(top);
  }
});

test("both directions of the mapping answer 0, not NaN, when the sheet fits without scrolling", () => {
  // A short sheet has vMax === rMax === 0: nothing to scroll, in either unit.
  expect(scrollerToTop(5, 0, 0)).toBe(0);
  expect(topToScroller(5, 0, 0)).toBe(0);
});

// --------------------------------------------------------------- painting

test("the first drawn row clamps so the last screenful is full at the very end of the sheet", () => {
  const total = 4812;
  const pool = poolSize(total, 600, ROW_H);
  // Scrolled arbitrarily far down -- well past the sheet's own height -- the
  // first row must still leave exactly `pool` rows to draw, ending on the
  // sheet's last row rather than running off the end.
  const first = firstRow(total, pool, 999_999_999, ROW_H);
  expect(first).toBe(total - pool);
  expect(first + pool - 1).toBe(total - 1);
});

test("the pool holds a screenful plus the overscan, and never more rows than the sheet has", () => {
  expect(poolSize(4812, 600, ROW_H)).toBe(Math.ceil(600 / ROW_H) + 6);
  expect(poolSize(10, 600, ROW_H), "a sheet shorter than a screenful").toBe(10);
});

test("the table offset is a whole number", () => {
  const offset = tableOffset(100.4, 250.7, 3, ROW_H);
  expect(Number.isInteger(offset)).toBe(true);
});

// ----------------------------------------------------------------- jumps

test("scrolling into view moves as little as puts the row wholly on screen", () => {
  const top = 10 * ROW_H; // rows 10..19 are the ten rows on screen
  const height = 10 * ROW_H;

  expect(intoView(5, ROW_H, top, height), "above the view").toBe(5 * ROW_H);
  expect(intoView(25, ROW_H, top, height), "below the view").toBe(25 * ROW_H + ROW_H - height);
  expect(intoView(15, ROW_H, top, height), "already wholly on screen").toBeUndefined();
});

test("zt, zz and zb place a row at the top, middle and bottom of the screen", () => {
  const height = 310;
  expect(scrollTarget(50, ROW_H, height, "top")).toBe(50 * ROW_H);
  expect(scrollTarget(50, ROW_H, height, "bottom")).toBe(50 * ROW_H + ROW_H - height);
  expect(scrollTarget(50, ROW_H, height, "middle")).toBe(50 * ROW_H + (ROW_H - height) / 2);
});

test("zt, zz and zb clamp at row 0 and at the last row", () => {
  const total = 100;
  const height = 310;
  const vMax = measure(total, ROW_H, 0, height).vMax;

  // zb on row 0 wants to scroll above the top of the sheet.
  expect(clampTop(scrollTarget(0, ROW_H, height, "bottom"), vMax)).toBe(0);
  // zz on row 0 wants to scroll above the top of the sheet too.
  expect(clampTop(scrollTarget(0, ROW_H, height, "middle"), vMax)).toBe(0);
  // zt on the last row wants to scroll past the sheet's own end.
  expect(clampTop(scrollTarget(total - 1, ROW_H, height, "top"), vMax)).toBe(vMax);
  // zb on the last row lands exactly at the sheet's end.
  expect(clampTop(scrollTarget(total - 1, ROW_H, height, "bottom"), vMax)).toBe(vMax);
});

// ---------------------------------------------------------------- ranges

test("the visible range is the rows wholly on screen", () => {
  const top = 10 * ROW_H;
  const height = 10 * ROW_H;
  expect(visibleRange(top, ROW_H, height, 4812)).toEqual({ top: 10, bottom: 19 });
});

test("the visible range at the end of the sheet clamps rather than running past the last row", () => {
  // top + height reaches past row 95's own top, but there is no row past 94.
  const range = visibleRange(2900, ROW_H, 310, 95);
  expect(range.bottom).toBe(94);
  expect(range.top).toBeLessThanOrEqual(range.bottom);
});

test("a page is at least 1 row even when the viewport is shorter than one row", () => {
  expect(pageSize(20, ROW_H)).toBe(1);
  expect(pageSize(600, ROW_H)).toBe(Math.floor(600 / ROW_H) - 1);
});
