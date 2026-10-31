/**
 * @fileoverview The layer over the sheet: one window per chart, drawn from its
 * place in the room the sheet leaves, and placed again as the sheet resizes.
 *
 * happy-dom has no layout, so each test says what layout would measure, and
 * fires the resize a ResizeObserver would.
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

/** Fires what a ResizeObserver on the sheet would. */
let resized: () => void;

/** A ResizeObserver that fires only when a test says, and only on #content. */
class HeldObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    if (target === content()) resized = () => this.callback([], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** Sets a layout number happy-dom leaves at zero on one element. */
function measures(element: HTMLElement, name: keyof HTMLElement, value: number): void {
  Object.defineProperty(element, name, { configurable: true, value });
}

/** Says what the layer's box measures. */
function roomIs({ w, h }: Room): void {
  vi.spyOn(root(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, w, h));
}

/** Says what the layer's box measures now, and fires the resize. */
function resize(room: Room): void {
  roomIs(room);
  resized();
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

/** A layer over a model holding `charts`, in ROOM, and that model. */
function shown(...charts: Chart[]): { layer: ChartLayer; model: { all: readonly Chart[] } } {
  const model = { all: charts };
  const layer = new ChartLayer(root(), content());
  roomIs(ROOM);
  layer.show(model);
  return { layer, model };
}

beforeEach(() => {
  document.body.innerHTML = bodyMarkup();
  const grid = document.createElement("div");
  grid.className = "grid-scroll";
  content().append(grid);
  vi.stubGlobal("ResizeObserver", HeldObserver);
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

test("the layer starts below the header row, and moves down with a banner", () => {
  shown(FLUSH);
  expect(root().style.top).toBe(`${HEAD}px`);

  measures(content(), "offsetTop", BANNER);
  resize(ROOM);
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

test("a resize places every window again from its chart's place", () => {
  shown(FLUSH, INSIDE);
  const narrower = { w: 700, h: 500 };
  resize(narrower);
  expect(windows().map(drawn)).toStrictEqual([
    placed(FLUSH.place, narrower),
    placed(INSIDE.place, narrower),
  ]);
});

test("a resize reads where each chart stands by then", () => {
  const { model } = shown(FLUSH);
  model.all = [{ ...FLUSH, place: MOVED }];
  resize(ROOM);
  expect(drawn(windows()[0]!)).toStrictEqual(placed(MOVED, ROOM));
});

test("a draw takes away the window of a chart that went, and keeps the others", () => {
  const { layer, model } = shown(FLUSH, INSIDE);
  const kept = windows()[1];

  model.all = [INSIDE];
  layer.draw();
  expect(windows()).toHaveLength(1);
  expect(windows()[0]).toBe(kept);
});

test("a chart that comes back, as a refused removal brings it, has a window again", () => {
  const { layer, model } = shown(FLUSH);
  model.all = [];
  layer.draw();

  model.all = [FLUSH];
  layer.draw();
  expect(windows()).toHaveLength(1);
});

test("a draw adds a window for a new chart, after the others", () => {
  const { layer, model } = shown(FLUSH);
  const first = windows()[0];

  model.all = [FLUSH, INSIDE];
  layer.draw();
  expect(windows()[0]).toBe(first);
  expect(windows().map(drawn)).toStrictEqual([
    placed(FLUSH.place, ROOM),
    placed(INSIDE.place, ROOM),
  ]);
});

test("another workspace's charts take new windows, whatever their ids", () => {
  const { layer } = shown(FLUSH);
  const was = windows()[0];

  layer.show({ all: [{ ...FLUSH, place: MOVED }] });
  expect(windows()).toHaveLength(1);
  expect(windows()[0]).not.toBe(was);
  expect(drawn(windows()[0]!)).toStrictEqual(placed(MOVED, ROOM));
});
