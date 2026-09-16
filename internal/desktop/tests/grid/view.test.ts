// @vitest-environment happy-dom
//
// The view over a plain DOM: what sits between the browser's scroller and the
// arithmetic in metrics.ts. happy-dom skips layout, so the scroller is
// told its height, and a resize is the observer's callback fired by hand.

import { afterEach, expect, test, vi } from "vite-plus/test";

import type { Kind } from "@uno/grid/sheet";

import { OVERSCAN } from "../../src/renderer/grid/metrics.ts";
import type { Rows } from "../../src/renderer/grid/rows.ts";
import { View } from "../../src/renderer/grid/view.ts";
import { m } from "../../src/paraglide/messages.js";

/** The row height the view falls back to with the stylesheet unloaded. */
const ROW_H = 29;
/** The header height the view is told, since happy-dom skips layout. */
const HEAD_H = 30;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A sheet of `total` rows and `cols` columns. Each cell's text is its coordinates. */
function sheet(total: number, cols = 2): Rows {
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

/** Waits two animation frames, which is how the view schedules its layout. */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function drawn(scroller: HTMLElement): number {
  return scroller.querySelectorAll("tbody tr").length;
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
