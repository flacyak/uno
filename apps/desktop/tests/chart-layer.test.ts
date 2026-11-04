/**
 * @fileoverview The layer over the sheet: one window per chart, drawn from its
 * place in the room the sheet leaves, and placed again as the sheet resizes.
 *
 * happy-dom has no layout, so each test says what layout would measure, and
 * fires the resize a ResizeObserver would.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { Chart } from "@document";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { ChartLayer } from "@renderer/chart/layer";
import { MIN_HEIGHT, MIN_WIDTH, placed } from "@renderer/chart/place";
import type { Rect, Room } from "@renderer/chart/place";
import { madeTitle } from "@renderer/chart/window";
import { BARS, MOVED } from "./charted.ts";
import { bodyMarkup } from "./markup.ts";

/** The header row's height, which view.ts falls back to with no stylesheet. */
const HEAD = 29;
/** A window's border at 100% zoom. */
const BORDER = 1;
/** A room with space for every window at its place. */
const ROOM: Room = { w: 1000, h: 600 };
/** What a banner's height puts above the grid. */
const BANNER = 44;
/** Scrollbars a browser draws for itself, past uno's 12 px and not a whole px. */
const SIDE_BAR = 17.5;
const FOOT_BAR = 15.25;
/** More heads than a room of the least height holds. */
const TOO_MANY_HEADS = Math.ceil(MIN_HEIGHT / HEAD) + 1;

/** One chart flush to the room's right edge, and one in the middle of it. */
const FLUSH: Chart = BARS;
const INSIDE: Chart = { ...BARS, id: "c2", place: MOVED };

/** The name a workspace of several sources gives a window's source. */
const SOURCE = "sales-q3";

/** What the layer reads of a workspace's charts, for a test to change. */
interface Model {
  all: readonly Chart[];
  sourceLabel(source: string): string | undefined;
}

const root = (): HTMLElement => document.querySelector<HTMLElement>("#charts")!;
const content = (): HTMLElement => document.querySelector<HTMLElement>("#content")!;
const scroller = (): HTMLElement => document.querySelector<HTMLElement>(".grid-scroll")!;
const gauge = (): HTMLElement => document.querySelector<HTMLElement>(".grid-scroll .chart-gauge")!;
const windows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".chart")];
const titles = (): Array<string | null> =>
  [...document.querySelectorAll(".chart-title")].map((title) => title.textContent);

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

/** Says what the grid's box measures, and how much of it two scrollbars take. */
function barsAre(side: number, foot: number): void {
  const { w, h } = ROOM;
  vi.spyOn(scroller(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, w, h));
  vi.spyOn(gauge(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, w - side, h - foot));
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

/** A model of a workspace of one source, holding `charts`. */
function modelOf(...charts: Chart[]): Model {
  return { all: charts, sourceLabel: () => undefined };
}

/** A layer over a model holding `charts`, in ROOM, and that model. */
function shown(...charts: Chart[]): { layer: ChartLayer; model: Model } {
  const model = modelOf(...charts);
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

afterEach(() => {
  vi.unstubAllGlobals();
  void setLocale(baseLocale, { reload: false });
});

test("the layer stays hidden until a workspace shows, and each chart has a window at its place", () => {
  const layer = new ChartLayer(root(), content());
  roomIs(ROOM);
  expect(root().hidden).toBe(true);

  layer.show(modelOf(FLUSH, INSIDE));
  expect(root().hidden).toBe(false);
  expect(windows().map(drawn)).toStrictEqual([
    placed(FLUSH.place, ROOM),
    placed(INSIDE.place, ROOM),
  ]);
  expect(drawn(windows()[0]!).x).toBe(ROOM.w - FLUSH.place.width);
});

test("the layer starts on the header row's rule, and moves down with a banner", () => {
  shown(FLUSH);
  expect(root().style.top).toBe(`${HEAD - BORDER}px`);

  const below = new DOMRect(0, BANNER, ROOM.w, ROOM.h);
  vi.spyOn(content(), "getBoundingClientRect").mockReturnValue(below);
  resize(ROOM);
  expect(root().style.top).toBe(`${BANNER + HEAD - BORDER}px`);
});

test.each([
  ["under 100%, a border of one device px is wider", 0.8, 1.25],
  ["at 125%, it is one device px still", 1.25, 0.8],
  ["at 200%, it is two", 2, 1],
])("%s, and the layer lands on the rule", (_zoom, ratio, border) => {
  vi.stubGlobal("devicePixelRatio", ratio);
  shown(FLUSH);
  expect(root().style.top).toBe(`${HEAD - border}px`);
  expect(root().style.getPropertyValue("--window-border")).toBe(`${border}px`);
});

test("the layer's sides keep clear of scrollbars of any width", () => {
  const { layer } = shown(FLUSH);
  barsAre(SIDE_BAR, FOOT_BAR);
  layer.draw();
  expect(root().style.getPropertyValue("--bar-right")).toBe(`${SIDE_BAR}px`);
  expect(root().style.getPropertyValue("--bar-bottom")).toBe(`${FOOT_BAR}px`);
});

test("a tab with no scrollbars keeps the last measure, so the room holds still", () => {
  const { layer } = shown(FLUSH);
  barsAre(SIDE_BAR, 0);
  layer.draw();
  expect(root().style.getPropertyValue("--bar-bottom")).toBe("");

  barsAre(0, 0);
  layer.draw();
  expect(root().style.getPropertyValue("--bar-right")).toBe(`${SIDE_BAR}px`);
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

  layer.show(modelOf({ ...FLUSH, place: MOVED }));
  expect(windows()).toHaveLength(1);
  expect(windows()[0]).not.toBe(was);
  expect(drawn(windows()[0]!)).toStrictEqual(placed(MOVED, ROOM));
});

test("a relabel keeps every window", () => {
  const { layer } = shown(FLUSH, INSIDE);
  const were = windows();

  layer.relabel();
  expect(windows()).toHaveLength(were.length);
  were.forEach((box, i) => expect(windows()[i]).toBe(box));
});

test("a relabel writes each window's words in the language chosen since", () => {
  const { layer } = shown(FLUSH);
  void setLocale("es", { reload: false });
  layer.relabel();
  expect(titles()).toStrictEqual([madeTitle(FLUSH.plot)]);
  expect(windows()[0]!.getAttribute("aria-roledescription")).toBe(m.chart_role());
});

test("a draw says what each chart and its source say by then, in the same window", () => {
  const { layer, model } = shown(FLUSH);
  const made = windows()[0];
  model.all = [{ ...FLUSH, title: "Rows" }];
  layer.draw();
  expect(titles()).toStrictEqual(["Rows"]);

  model.sourceLabel = () => SOURCE;
  layer.draw();
  expect(titles()).toStrictEqual([`${SOURCE} · Rows`]);
  expect(windows()[0]).toBe(made);
});

test("a room too narrow tucks every window to its head, stacked from the top", () => {
  shown(FLUSH, INSIDE);
  const narrow = { w: MIN_WIDTH - 1, h: ROOM.h };
  resize(narrow);
  expect(windows().map(drawn)).toStrictEqual([
    { x: 0, y: 0, width: narrow.w, height: HEAD + BORDER },
    { x: 0, y: HEAD, width: narrow.w, height: HEAD + BORDER },
  ]);
});

test("a room too short tucks them too, and each goes back to its place with the room", () => {
  shown(FLUSH, INSIDE);
  resize({ w: ROOM.w, h: MIN_HEIGHT - 1 });
  const tucked = HEAD + BORDER;
  expect(windows().map((box) => drawn(box).height)).toStrictEqual([tucked, tucked]);

  resize(ROOM);
  expect(windows().map(drawn)).toStrictEqual([
    placed(FLUSH.place, ROOM),
    placed(INSIDE.place, ROOM),
  ]);
});

test("the layer says while it tucks, so heads can join into one stack", () => {
  shown(FLUSH, INSIDE);
  const tucking = (): boolean => root().classList.contains("tucked");
  expect(tucking()).toBe(false);

  resize({ w: ROOM.w, h: MIN_HEIGHT - 1 });
  expect(tucking()).toBe(true);

  resize(ROOM);
  expect(tucking()).toBe(false);
});

test("the stack's one shadow stands as high as the heads it lies behind", () => {
  shown(FLUSH, INSIDE);
  resize({ w: ROOM.w, h: MIN_HEIGHT - 1 });
  expect(root().style.getPropertyValue("--stack-height")).toBe(`${2 * HEAD + BORDER}px`);
});

test("a room with no windows is no stack, so it throws no shadow", () => {
  shown();
  resize({ w: ROOM.w, h: MIN_HEIGHT - 1 });
  expect(root().classList.contains("tucked")).toBe(false);
});

test("heads a room cannot hold stop at its foot, and only while they are too many", () => {
  shown(FLUSH, INSIDE);
  const held = (): boolean => root().classList.contains("overfull");
  expect(held()).toBe(false);

  const stack = 2 * HEAD + BORDER;
  resize({ w: ROOM.w, h: stack - 1 });
  expect(held()).toBe(true);

  resize({ w: ROOM.w, h: stack });
  expect(held()).toBe(false);

  resize({ w: ROOM.w, h: stack - 1 });
  resize(ROOM);
  expect(held()).toBe(false);
});

test("windows that stand whole keep their shadows, however many would not fit as heads", () => {
  const many = Array.from({ length: TOO_MANY_HEADS }, (_, i) => ({ ...FLUSH, id: `c${i}` }));
  shown(...many);
  resize({ w: ROOM.w, h: MIN_HEIGHT });
  expect(root().classList.contains("overfull")).toBe(false);
});

test("a room too narrow for a head shows nothing and loses nothing", () => {
  shown(FLUSH);
  resize({ w: 0, h: ROOM.h });
  expect(drawn(windows()[0]!).width).toBe(0);
  expect(root().classList.contains("thin")).toBe(true);

  resize(ROOM);
  expect(drawn(windows()[0]!)).toStrictEqual(placed(FLUSH.place, ROOM));
  expect(root().classList.contains("thin")).toBe(false);
});
