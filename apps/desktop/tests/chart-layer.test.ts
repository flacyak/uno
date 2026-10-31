/**
 * @fileoverview The layer over the sheet: one window per chart, drawn from its
 * place in the room the sheet leaves.
 *
 * happy-dom has no layout, so each test says what layout would measure.
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, expect, test, vi } from "vite-plus/test";

import type { Chart } from "@document";
import { ChartLayer } from "@renderer/chart/layer";
import { placed } from "@renderer/chart/place";
import type { Rect, Room } from "@renderer/chart/place";
import { BARS, MOVED } from "./charted.ts";
import { bodyMarkup } from "./markup.ts";

/** The header row's height, which view.ts falls back to with no stylesheet. */
const HEAD = 29;
/** A room with space for every window at its place. */
const ROOM: Room = { w: 1000, h: 600 };
/** What a banner's height puts above the grid. */
const BANNER = 44;
/** Scrollbars a browser draws for itself, each past uno's 12 px. */
const SIDE_BAR = 17;
const FOOT_BAR = 15;

/** One chart flush to the room's right edge, and one in the middle of it. */
const FLUSH: Chart = BARS;
const INSIDE: Chart = { ...BARS, id: "c2", place: MOVED };

const root = (): HTMLElement => document.querySelector<HTMLElement>("#charts")!;
const content = (): HTMLElement => document.querySelector<HTMLElement>("#content")!;
const scroller = (): HTMLElement => document.querySelector<HTMLElement>(".grid-scroll")!;
const windows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".chart")];

/** Sets a layout number happy-dom leaves at zero on one element. */
function measures(element: HTMLElement, name: keyof HTMLElement, value: number): void {
  Object.defineProperty(element, name, { configurable: true, value });
}

/** Says what the layer's box measures. */
function roomIs({ w, h }: Room): void {
  vi.spyOn(root(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, w, h));
}

/** The box a window stands in, read from its style. */
function drawn({ style }: HTMLElement): Rect {
  return {
    x: parseFloat(style.left),
    y: parseFloat(style.top),
    width: parseFloat(style.width),
    height: parseFloat(style.height),
  };
}

/** A layer showing `charts` in ROOM. */
function shown(...charts: Chart[]): ChartLayer {
  const layer = new ChartLayer(root(), content());
  roomIs(ROOM);
  layer.show({ all: charts });
  return layer;
}

beforeEach(() => {
  document.body.innerHTML = bodyMarkup();
  const grid = document.createElement("div");
  grid.className = "grid-scroll";
  content().append(grid);
});

test("the layer stays hidden until a workspace shows, and each chart has a window at its place", () => {
  const layer = new ChartLayer(root(), content());
  roomIs(ROOM);
  expect(root().hidden).toBe(true);

  layer.show({ all: [FLUSH, INSIDE] });
  expect(root().hidden).toBe(false);
  expect(windows().map(drawn)).toStrictEqual([
    placed(FLUSH.place, ROOM),
    placed(INSIDE.place, ROOM),
  ]);
  expect(drawn(windows()[0]!).x).toBe(ROOM.w - FLUSH.place.width);
});

test("the layer starts below the header row, under any banner", () => {
  shown(FLUSH);
  expect(root().style.top).toBe(`${HEAD}px`);

  measures(content(), "offsetTop", BANNER);
  shown(FLUSH);
  expect(root().style.top).toBe(`${BANNER + HEAD}px`);
});

test("the layer's sides keep clear of scrollbars wider than uno's own", () => {
  measures(scroller(), "offsetWidth", ROOM.w);
  measures(scroller(), "clientWidth", ROOM.w - SIDE_BAR);
  measures(scroller(), "offsetHeight", ROOM.h);
  measures(scroller(), "clientHeight", ROOM.h - FOOT_BAR);
  shown(FLUSH);
  expect(root().style.getPropertyValue("--bar-right")).toBe(`${SIDE_BAR}px`);
  expect(root().style.getPropertyValue("--bar-bottom")).toBe(`${FOOT_BAR}px`);
});
