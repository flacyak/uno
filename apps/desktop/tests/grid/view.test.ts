/**
 * @fileoverview The view over a plain DOM: what sits between the browser's
 * scroller and the arithmetic in metrics.ts. happy-dom skips layout, so the
 * scroller is told its height, and a resize is the observer's callback fired by
 * hand.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test, vi } from "vite-plus/test";

import type { Kind } from "@sheet";

import { OVERSCAN } from "@renderer/grid/metrics";
import type { Rows } from "@renderer/grid/rows";
import { View } from "@renderer/grid/view";
import { m } from "@paraglide/messages";
import { frame } from "@desktop-tests/smoke/dom-page";

/** The row height the view falls back to with the stylesheet unloaded. */
const ROW_H = 29;
/** The header height the view is told, since happy-dom skips layout. */
const HEAD_H = 30;
/** A sheet far past the scroller's cap, where one row is under a px of scrollTop. */
const VAST = 100_000_000;
/** Where the second column's header cell stands on the screen, as layout would put it. */
const SECOND_HEAD = new DOMRect(100, 50, 80, HEAD_H);
/** A wheel's deltas in px, which its mode reads as they are. */
const PIXELS = WheelEvent.DOM_DELTA_PIXEL;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A sheet of `total` rows and `cols` columns. Each cell's text is its coordinates. */
function sheet(total: number, cols = 2): Rows {
  const kind: Kind = "text";
  return {
    columns: Array.from({ length: cols }, (_, c) => ({
      header: `c${c}`,
      kind,
      flagged: false,
      mark: "point",
    })),
    rows: () => total,
    cols: () => cols,
    display: (row, col) => `${row},${col}`,
    raw: (row, col) => `${row},${col}`,
    binding: () => undefined,
  };
}

/** Builds a view on a scroller told it is `viewport` pixels tall. */
function make(viewport: number): {
  view: View;
  scroller: HTMLElement;
  height: (px: number) => void;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new View(
    host,
    () => ({ row: 0, col: 0 }),
    () => undefined,
  );
  const head = view.scroller.querySelector("thead")!;
  Object.defineProperty(head, "offsetHeight", { value: HEAD_H });
  const height = (px: number): void => {
    Object.defineProperty(view.scroller, "clientHeight", { value: px, configurable: true });
  };
  height(viewport);
  return { view, scroller: view.scroller, height };
}

function drawn(scroller: HTMLElement): number {
  return scroller.querySelectorAll("tbody tr").length;
}

/** Turns a wheel one row down on `scroller`, with `keys` held. */
function turn(
  scroller: HTMLElement,
  keys: Pick<WheelEventInit, "ctrlKey" | "shiftKey"> = {},
): WheelEvent {
  // happy-dom's WheelEvent keeps no modifier keys.
  const init = { deltaY: ROW_H, cancelable: true };
  const event = Object.assign(new WheelEvent("wheel", init), keys);
  scroller.dispatchEvent(event);
  return event;
}

// ---------------------------------------------------------------- gutter

test("the gutter numbers rows grouped the way the status bar counts them", async () => {
  const { view, scroller } = make(600);
  view.show(sheet(4812), false);
  view.scrollRow(4811, "bottom");
  await frame();
  const last = [...scroller.querySelectorAll("tbody tr")].at(-1)!;
  expect(last.children[0]!.textContent).toBe("4,812");
  // The gutter width is that number's digit count, grouping included.
  expect(view.scroller.querySelector("table")!.style.getPropertyValue("--gutter-digits")).toBe("5");
});

// -------------------------------------------------------------- scrolling

test("zt puts the row at the top of the visible range, with nothing lost to rounding", () => {
  // 32 rows at 29px under a 30px header in a 600px viewport leave 358px of
  // scroll. Row 7 is at 203px, and 203 / 358 * 358 is a hair over 203, which
  // ceil would read as row 8.
  const { view } = make(600);
  view.show(sheet(32), false);

  view.scrollRow(7, "top");

  expect(view.visibleRows().top).toBe(7);
});

test("a fresh open starts at the first column, however far the last one had scrolled", () => {
  const { view, scroller } = make(600);
  view.show(sheet(40, 12), false);
  scroller.scrollLeft = 500;

  view.show(sheet(40, 12), false);

  expect(scroller.scrollLeft).toBe(0);
  expect(scroller.scrollTop).toBe(0);
});

test("the same rows shown again keep where they were scrolled to", () => {
  const { view, scroller } = make(600);
  view.show(sheet(40, 12), false);
  scroller.scrollLeft = 500;

  view.show(sheet(40, 12), true);

  expect(scroller.scrollLeft).toBe(500);
});

/** Stands the second column's header cell, and the scroller `viewport` px tall from its top, on the screen. */
function stand(scroller: HTMLElement, viewport: number): void {
  // The gutter's header cell comes first.
  const head = scroller.querySelector("thead tr")!.children[2]!;
  vi.spyOn(head, "getBoundingClientRect").mockReturnValue(SECOND_HEAD);
  const box = new DOMRect(0, SECOND_HEAD.top, SECOND_HEAD.right, viewport);
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(box);
}

test.each([
  ["an unscaled sheet", 40],
  ["a scaled sheet", VAST],
])("a cell scrolled to the foot of %s stands there, under its header cell", (_, total) => {
  const viewport = 600;
  const { view, scroller } = make(viewport);
  view.show(sheet(total), false);
  stand(scroller, viewport);

  view.scrollIntoView(total - 1, 1);
  view.layout();

  const { left, top, width } = SECOND_HEAD;
  expect(view.cellRect(total - 1, 1)).toEqual(
    new DOMRect(left, top + viewport - ROW_H, width, ROW_H),
  );
});

test("a cell scrolled under the header shows none of itself, and one partly under it the rest", () => {
  const viewport = 600;
  const { view, scroller } = make(viewport);
  view.show(sheet(40), false);
  stand(scroller, viewport);
  const halfRow = ROW_H / 2;

  scroller.scrollTop = ROW_H + halfRow;
  view.layout();

  const { left, bottom, width } = SECOND_HEAD;
  expect(view.cellRect(0, 1)).toBeUndefined();
  expect(view.cellRect(1, 1)).toEqual(new DOMRect(left, bottom, width, halfRow));
});

// ------------------------------------------------------------------ wheel

test("a wheel from outside scrolls an unscaled sheet by its px, down and along", () => {
  const { view, scroller } = make(600);
  view.show(sheet(1000, 12), false);

  view.wheelBy(40, 2 * ROW_H, PIXELS);

  expect(scroller.scrollTop).toBe(2 * ROW_H);
  expect(scroller.scrollLeft).toBe(40);
});

test("a wheel from outside counts in rows or in pages when its mode says so", () => {
  const { view, scroller } = make(600);
  view.show(sheet(1000, 12), false);

  view.wheelBy(3, 3, WheelEvent.DOM_DELTA_LINE);
  expect(scroller.scrollTop).toBe(3 * ROW_H);
  expect(scroller.scrollLeft).toBe(3 * ROW_H);

  view.wheelBy(0, 1, WheelEvent.DOM_DELTA_PAGE);
  expect(scroller.scrollTop).toBe(3 * ROW_H + 600);
});

test("a wheel from outside stops at the sheet's ends", () => {
  const { view, scroller } = make(600);
  view.show(sheet(1000), false);

  view.wheelBy(0, -ROW_H, PIXELS);
  expect(scroller.scrollTop).toBe(0);

  view.wheelBy(0, 1000 * ROW_H, PIXELS);
  expect(scroller.scrollTop).toBe(1000 * ROW_H + HEAD_H - 600);
});

test("a wheel from outside moves a scaled sheet one row, a step its scrollTop cannot hold", async () => {
  const { view, scroller } = make(600);
  view.show(sheet(VAST), false);

  view.wheelBy(0, ROW_H, PIXELS);
  await frame();

  expect(view.visibleRows().top).toBe(1);
  expect(scroller.querySelector("tbody tr")!.children[0]!.textContent).toBe("2");
});

test("a wheel on a scaled sheet's scroller moves it the same way, and Ctrl+wheel stays zoom", async () => {
  const { view, scroller } = make(600);
  view.show(sheet(VAST), false);

  expect(turn(scroller).defaultPrevented).toBe(true);
  await frame();
  expect(view.visibleRows().top).toBe(1);

  expect(turn(scroller, { ctrlKey: true }).defaultPrevented).toBe(false);
  await frame();
  expect(view.visibleRows().top).toBe(1);
});

test("Shift and a wheel on a scaled sheet's scroller go along its rows", async () => {
  const { view, scroller } = make(600);
  view.show(sheet(VAST), false);

  turn(scroller, { shiftKey: true });
  await frame();

  expect(view.visibleRows().top).toBe(0);
  expect(scroller.scrollLeft).toBe(ROW_H);
});

// --------------------------------------------------------------- resizing

test("a taller scroller draws more rows on the next frame", async () => {
  // happy-dom's ResizeObserver is inert, so the test captures the
  // view's callback and fires it.
  let resized: (() => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = () => callback([], this as unknown as ResizeObserver);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );

  const { view, scroller, height } = make(300);
  view.show(sheet(1000), false);
  expect(drawn(scroller)).toBe(Math.ceil(300 / ROW_H) + OVERSCAN);

  height(900);
  expect(resized, "the view watches its scroller").toBeDefined();
  resized?.();
  await frame();

  expect(drawn(scroller)).toBe(Math.ceil(900 / ROW_H) + OVERSCAN);
});

// ----------------------------------------------------------------- header

test("a blank header is drawn as the column's place, and dressed as a name the file did not give", () => {
  const { view, scroller } = make(600);
  const rows = sheet(10, 3);
  // An empty header, and one of only spaces.
  const columns = [...rows.columns];
  columns[0] = { ...columns[0]!, header: "" };
  columns[2] = { ...columns[2]!, header: "   " };
  view.show({ ...rows, columns }, false);

  const names = [...scroller.querySelectorAll("thead th .colname")];
  expect(names.map((n) => n.textContent)).toEqual([
    m.column_unnamed({ number: 1 }),
    "c1",
    m.column_unnamed({ number: 3 }),
  ]);
  expect(names.map((n) => n.classList.contains("unnamed"))).toEqual([true, false, true]);
  // Every column still has its badge, and the body row has all its cells.
  expect(scroller.querySelectorAll("thead th .badge").length).toBe(3);
  expect(scroller.querySelector("tbody tr")?.children.length).toBe(4);
});

test("a kind badge says on hover that its column does not parse, or reads a decimal comma", () => {
  const { view, scroller } = make(200);
  const rows = sheet(10, 3);
  const columns = [...rows.columns];
  columns[1] = { ...columns[1]!, kind: "num", mark: "comma" };
  columns[2] = { ...columns[2]!, flagged: true, mark: "comma" };
  view.show({ ...rows, columns }, false);

  const badges = [...scroller.querySelectorAll<HTMLElement>("thead th .badge")];
  expect(badges.map((badge) => badge.title)).toEqual([
    "",
    m.column_decimal_comma_hint(),
    `${m.column_flagged_hint()} · ${m.column_decimal_comma_hint()}`,
  ]);
});
