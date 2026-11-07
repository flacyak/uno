/**
 * @fileoverview The layer over the sheet: one window per chart, drawn from its
 * place in the room the sheet leaves, and placed again as the sheet resizes. A
 * window moves and resizes under a pointer and the arrow keys, and a wheel over
 * one goes on to the sheet unless something inside it can still scroll.
 *
 * happy-dom has no layout, so each test says what layout would measure, and
 * fires the resize a ResizeObserver would. Its pointer capture is bookkeeping
 * only, so each test sends a pointer's events to the element that holds it.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { Chart, ChartPlace } from "@document";
import { DISTINCT_AT_MOST } from "@engine";
import type { GroupsTally, SampleTally, Skipped } from "@engine";
import { BLANK_ROWS, REGION, REVENUE, ROWS, UNITS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { ChartLayer } from "@renderer/chart/layer";
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  NUDGE_PX,
  dragged,
  placeOf,
  placed,
  stretched,
} from "@renderer/chart/place";
import type { Rect, Room } from "@renderer/chart/place";
import { madeTitle } from "@renderer/chart/window";
import type { Heard, SourceState } from "@renderer/charts";
import { num } from "@renderer/locale";
import { BARS, MOVED, PIE, SCATTER, SHARES, SHORT_ROWS, holding } from "./charted.ts";
import { bodyMarkup } from "./markup.ts";
import { frame } from "./smoke/dom-page.ts";

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

/** A chart over INSIDE. */
const OVER: Chart = { ...INSIDE, id: "c3" };

/** The name a workspace of several sources gives a window's source. */
const SOURCE = "sales-q3";

/** A source a chart reads, as its window hears it. */
const FINE: SourceState = { state: "fine", name: `${SOURCE}.csv` };

/** A room under the least height, which tucks every window to its head. */
const TUCKING: Room = { w: ROOM.w, h: MIN_HEIGHT - 1 };

/** Where a pointer takes hold, and a step that keeps INSIDE inside ROOM. */
const HOLD = { x: 500, y: 100 };
const STEP = { x: -60, y: 40 };

/** How far past the room a pointer can go. */
const FAR = ROOM.w + ROOM.h;

/** The button that opens a context menu. */
const SECONDARY = 2;

/** The pointer a test holds a window with, and a second finger on it. */
const POINTER = 1;
const OTHER_POINTER = 2;

/** A turn of the wheel in lines, read through to the grid as they are. */
const TURN = { deltaX: 3, deltaY: 5, deltaMode: WheelEvent.DOM_DELTA_LINE };

/** How far a scrollable scrolls each way, and where it stands at each end. */
const END = 300;
const START = { scrollTop: 0, scrollLeft: 0 };
const FOOT = { ...START, scrollTop: END };
const SIDE = { ...START, scrollLeft: END };

/** A turn of the wheel in px. */
const DOWN = { deltaY: 10 };
const UP = { deltaY: -10 };
const RIGHT = { deltaX: 10 };
const LEFT = { deltaX: -10 };

/** What a wheel can turn with. */
type HeldKeys = Pick<WheelEventInit, "ctrlKey" | "shiftKey">;

/** What the layer reads of a workspace's charts, for a test to change. */
interface Model {
  all: readonly Chart[];
  sourceLabel(source: string): string | undefined;
  move: (id: string, place: ChartPlace) => void;
  heard: (id: string) => Heard | undefined;
}

const root = (): HTMLElement => document.querySelector<HTMLElement>("#charts")!;
const content = (): HTMLElement => document.querySelector<HTMLElement>("#content")!;
const scroller = (): HTMLElement => document.querySelector<HTMLElement>(".grid-scroll")!;
const gauge = (): HTMLElement => document.querySelector<HTMLElement>(".grid-scroll .chart-gauge")!;
const windows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".chart")];
const titles = (): Array<string | null> =>
  [...document.querySelectorAll(".chart-title")].map((title) => title.textContent);
const labels = (): Array<string | null> =>
  [...document.querySelectorAll(".chart-bar-label")].map((label) => label.textContent);

/** The first window, and the parts of it a pointer takes hold of. */
const first = (): HTMLElement => windows()[0]!;
const part = (selector: string): HTMLElement => first().querySelector<HTMLElement>(selector)!;
const head = (): HTMLElement => part(".chart-head");
const said = (): string => part(".chart-said").textContent ?? "";
const grip = (): HTMLElement => part(".chart-grip");

/** Fires what a ResizeObserver on the sheet would, and one on the last window's plot. */
let resized: () => void;
let plotResized: () => void;

/** What the layer calls to give the grid its keys back. */
const leave = vi.fn();

/** What the layer calls to scroll the sheet. */
const wheelBy = vi.fn();

/** What the layer calls to open the sources panel on a window's source. */
const repoint = vi.fn();

/** What the layer calls to find the cells a window's tally could not read as numbers. */
const notNumbers = vi.fn();

/** What the layer calls to open the chart form on a window's chart. */
const edit = vi.fn();

/** What the layer calls to remove a window's chart. */
const remove = vi.fn();

/** Everything the layer asks of the shell. */
const asks = { leave, wheelBy, repoint, notNumbers, edit, remove };

/** A ResizeObserver that fires only when a test says, and only on #content or a plot. */
class HeldObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    if (target === content()) resized = () => this.callback([], this);
    if (target.matches(".chart-plot")) plotResized = () => this.callback([], this);
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
  const model: Model = {
    all: charts,
    sourceLabel: () => undefined,
    heard: () => undefined,
    move: vi.fn((id: string, place: ChartPlace) => {
      model.all = model.all.map((chart) => (chart.id === id ? { ...chart, place } : chart));
    }),
  };
  return model;
}

/** What FLUSH's chart heard once its source was read: a row of each of `values`. */
function heardOf(...values: string[]): Heard {
  const none = { values: 0, rows: 0, sum: 0 };
  const tally: GroupsTally = {
    t: "groups",
    plot: FLUSH.plot,
    coverage: { rows: values.length, total: values.length, complete: true },
    groups: values.map((value) => ({ value, rows: 1, sum: 0 })),
    others: none,
    below: none,
    rest: none,
    skipped: { blank: 0, unparsed: 0 },
  };
  return { ...FINE, latest: tally, complete: tally };
}

/** What FLUSH's chart heard with `rows` of `total` read: a tally of East, still being read. */
function readOf(rows: number, total: number): Heard {
  const { latest } = heardOf("East");
  const tally =
    latest?.t === "groups" ? { ...latest, coverage: { rows, total, complete: false } } : undefined;
  return { ...FINE, latest: tally, complete: undefined };
}

/** Units and revenue of two rows of the sales export, as a scatter's tally sends them. */
const SENT = { x: [180, 999], y: [7200, 39960] };

/** What SCATTER's chart heard once its source was read: SENT, of `plotted` rows. */
function pointsHeard(plotted = SENT.x.length): Heard {
  const tally: SampleTally = {
    t: "sample",
    plot: SCATTER.plot,
    coverage: { rows: plotted, total: plotted, complete: true },
    x: SENT.x,
    y: SENT.y,
    plotted,
    least: { x: SENT.x[0]!, y: SENT.y[0]! },
    most: { x: SENT.x[1]!, y: SENT.y[1]! },
    skipped: { blank: 0, unparsed: 0 },
  };
  return { ...FINE, latest: tally, complete: tally };
}

/** `heard` with the cells its tally left out counted as `skipped`. */
function leftOut(heard: Heard, skipped: Skipped): Heard {
  const { latest } = heard;
  const tally = latest === undefined || latest.t === "unread" ? undefined : { ...latest, skipped };
  return { ...heard, latest: tally, complete: tally };
}

/** A layer over a model holding `charts`, in ROOM, and that model. */
function shown(...charts: Chart[]): { layer: ChartLayer; model: Model } {
  const model = modelOf(...charts);
  const layer = new ChartLayer(root(), content(), asks);
  roomIs(ROOM);
  layer.show(model);
  return { layer, model };
}

/** Sends a pointer event to `at`, `x` and `y` px from where the pointer took hold. */
function pointer(
  type: string,
  at: Element,
  x = 0,
  y = 0,
  more: PointerEventInit = {},
): PointerEvent {
  const event = new PointerEvent(type, {
    pointerId: POINTER,
    clientX: HOLD.x + x,
    clientY: HOLD.y + y,
    bubbles: true,
    cancelable: true,
    ...more,
  });
  at.dispatchEvent(event);
  return event;
}

/** Takes hold of `zone` and carries it by STEP. */
function carry(zone: HTMLElement): void {
  pointer("pointerdown", zone);
  pointer("pointermove", zone, STEP.x, STEP.y);
}

/** Sends a keydown to the first window. */
function key(name: string, more: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...more,
  });
  first().dispatchEvent(event);
  return event;
}

/** Turns the wheel over `at`, with `keys` held. */
function turn(at: Element, init: WheelEventInit, keys: HeldKeys = {}): WheelEvent {
  // happy-dom's WheelEvent keeps no modifier keys.
  const made = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  const event = Object.assign(made, keys);
  at.dispatchEvent(event);
  return event;
}

/** A named scrollable in the first window's plot, that scrolls END px, standing `at`. */
function scrollable(at = START): HTMLElement {
  const inner = part(".chart-plot").appendChild(document.createElement("div"));
  inner.className = "chart-scrolls";
  // happy-dom has no layout, so a client size reads 0.
  Object.defineProperties(inner, { scrollHeight: { value: END }, scrollWidth: { value: END } });
  return Object.assign(inner, at);
}

beforeEach(() => {
  document.body.innerHTML = bodyMarkup();
  const grid = document.createElement("div");
  grid.className = "grid-scroll";
  content().append(grid);
  vi.stubGlobal("ResizeObserver", HeldObserver);
  leave.mockClear();
  wheelBy.mockClear();
  repoint.mockClear();
  notNumbers.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  void setLocale(baseLocale, { reload: false });
});

test("the layer stays hidden until a workspace shows, and each chart has a window at its place", () => {
  const layer = new ChartLayer(root(), content(), asks);
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

test("a window draws what its chart heard on the next frame, and again each time it shows", async () => {
  const { layer, model } = shown(FLUSH);
  Object.defineProperty(part(".chart-plot"), "clientHeight", { value: ROOM.h });
  model.heard = () => heardOf("North", "South");
  await frame();
  expect(labels()).toStrictEqual(["North", "South"]);
  // A changed chart hears nothing of its new plot until a tally of it comes.
  model.heard = () => undefined;
  layer.draw();
  await frame();
  expect(part(".chart-plot").childElementCount).toBe(0);
});

test("a window draws as each tally comes, and keeps a complete one while the next is read", async () => {
  const { layer, model } = shown(FLUSH);
  Object.defineProperty(part(".chart-plot"), "clientHeight", { value: ROOM.h });
  await frame();
  const reading = heardOf("East").latest;
  model.heard = () => ({ ...FINE, latest: reading, complete: undefined });
  layer.tallied(FLUSH.id);
  await frame();
  expect(labels()).toStrictEqual(["East"]);
  model.heard = () => ({ ...heardOf("North", "South"), latest: reading });
  layer.tallied(FLUSH.id);
  await frame();
  expect(labels()).toStrictEqual(["North", "South"]);
});

test("a track under the head shows how far a chart has read, until its tally completes", async () => {
  const { layer, model } = shown(FLUSH);
  Object.defineProperty(part(".chart-plot"), "clientHeight", { value: ROOM.h });
  const track = (): HTMLElement => part(".chart-coverage");
  const read = (): string => track().style.getPropertyValue("--read");
  model.heard = () => ({ ...FINE, latest: undefined, complete: undefined });
  await frame();
  expect([track().hidden, read()]).toStrictEqual([false, "0"]);
  expect(part(".chart-state").textContent).toBe(m.chart_reading({ name: FINE.name }));
  model.heard = () => readOf(2, 5);
  layer.tallied(FLUSH.id);
  await frame();
  expect([track().hidden, read()]).toStrictEqual([false, "0.4"]);
  expect(said()).toBe(m.chart_partial({ read: "40%" }));
  // The last complete tally stays drawn while the next is read, which the track shows.
  model.heard = () => ({ ...heardOf("North", "South"), latest: readOf(2, 5).latest });
  layer.tallied(FLUSH.id);
  await frame();
  expect(labels()).toStrictEqual(["North", "South"]);
  expect([track().hidden, read()]).toStrictEqual([false, "0.4"]);
  model.heard = () => heardOf("North", "South");
  layer.tallied(FLUSH.id);
  await frame();
  expect([track().hidden, said()]).toStrictEqual([true, m.rows_count({ count: 2 })]);
});

test("a window over a missing source says so and offers Re-point, which asks for the panel on its source", async () => {
  const { layer, model } = shown(FLUSH);
  model.heard = () => ({ ...FINE, state: "missing", latest: undefined, complete: undefined });
  await frame();
  const words = m.chart_source_missing({ name: FINE.name });
  expect(part(".chart-state").textContent).toBe(`${words}${m.action_repoint()}`);
  expect(part(".chart-coverage").hidden).toBe(true);
  part(".chart-state button").click();
  expect(repoint).toHaveBeenCalledExactlyOnceWith(FLUSH.source);
  void setLocale("es", { reload: false });
  layer.relabel();
  await frame();
  expect(part(".chart-state button").textContent).toBe(m.action_repoint());
  expect(part(".chart-state button").textContent).not.toBe("Re-point");
});

test("a window over a source waiting on its bucket offers to connect it", async () => {
  const { model } = shown(FLUSH);
  const bucket = "open-data";
  const waiting = { ...FINE, state: "unconnected", bucket } as const;
  model.heard = () => ({ ...waiting, latest: undefined, complete: undefined });
  await frame();
  expect(part(".chart-state bdi").textContent).toBe(m.chart_bucket_unconnected({ bucket }));
  const connect = part(".chart-state button");
  expect(connect.textContent).toBe(m.sources_connect_bucket({ bucket }));
  connect.click();
  expect(repoint).toHaveBeenCalledExactlyOnceWith(FLUSH.source);
});

test("a window draws its bars again in the frame its plot resizes", () => {
  const { model } = shown(FLUSH);
  model.heard = () => heardOf("North", "South", "West", "East");
  const plot = part(".chart-plot");
  Object.defineProperty(plot, "clientHeight", { value: ROOM.h, configurable: true });
  plotResized();
  expect(labels()).toStrictEqual(["North", "South", "West", "East"]);
  Object.defineProperty(plot, "clientHeight", { value: holding(SHORT_ROWS) });
  plotResized();
  expect(labels()).toStrictEqual(["North", "South"]);
});

test("a window draws a scatter's points from what its chart heard", async () => {
  const { model } = shown(SCATTER);
  model.heard = () => pointsHeard();
  await frame();
  expect(document.querySelectorAll(".chart-scatter .chart-point")).toHaveLength(SENT.x.length);
});

test("a window draws a pie's slices from what its chart heard", async () => {
  const { model } = shown(PIE);
  model.heard = () => heardOf("North", "South");
  await frame();
  expect(document.querySelectorAll(".chart-pie .chart-slice")).toHaveLength(2);
});

test("a pie's caption says how it counts the values past those a tally keeps apart, and the values at or below zero it leaves out", async () => {
  // A pie of sums: a share of rows leaves no value at or below zero out.
  const { model } = shown(SHARES);
  const { latest } = heardOf("North");
  const groups = [{ value: "North", rows: 1, sum: 10 }];
  const left = { rest: { rows: 5, sum: 0 }, below: { values: 2, rows: 2, sum: -8 } };
  const sums = { plot: SHARES.plot, groups, ...left };
  const tally = latest?.t === "groups" ? { ...latest, ...sums } : undefined;
  model.heard = () => ({ ...FINE, latest: tally, complete: tally });
  await frame();
  const past = m.chart_pie_past_left_out({ count: num(DISTINCT_AT_MOST) });
  const below = m.chart_pie_below_zero({ count: left.below.values });
  expect(said()).toBe(`${m.rows_count({ count: 1 })} · ${past} · ${below}`);
});

test("a scatter's caption says how many of its points it draws while it samples, in the language chosen, and nothing once it draws none", async () => {
  const { layer, model } = shown(SCATTER);
  model.heard = () => pointsHeard();
  await frame();
  expect(said()).toBe(m.rows_count({ count: SENT.x.length }));
  model.heard = () => pointsHeard(ROWS);
  layer.tallied(SCATTER.id);
  await frame();
  const points = (): string => m.chart_points({ count: ROWS });
  const words = (): string => {
    const sampled = m.chart_points_sampled({ shown: num(SENT.x.length), points: points() });
    return `${m.rows_count({ count: ROWS })} · ${sampled}`;
  };
  const english = words();
  expect(said()).toBe(english);
  void setLocale("es", { reload: false });
  layer.relabel();
  await frame();
  expect(said()).toBe(words());
  expect(said()).not.toBe(english);
  // A plot that draws no scatter says nothing of one.
  model.heard = () => undefined;
  layer.tallied(SCATTER.id);
  await frame();
  expect(said()).toBe("");
});

test("a caption counts what a tally left out after its rows, before what a scatter's sample leaves out, and its not-numbers count is the button that finds them", async () => {
  const { model } = shown(SCATTER);
  const left = { blank: BLANK_ROWS, unparsed: 1 };
  model.heard = () => leftOut(pointsHeard(ROWS), left);
  await frame();
  const counts = `${m.chart_blank({ count: num(left.blank) })} · ${m.chart_not_numbers({ count: 1 })}`;
  const all = m.chart_points({ count: ROWS });
  const points = m.chart_points_sampled({ shown: num(SENT.x.length), points: all });
  expect(said()).toBe(`${m.rows_count({ count: ROWS })} · ${counts} · ${points}`);
  expect(part(".chart-said").title).toBe(said());
  const find = part(".chart-find");
  expect(find.textContent).toBe(m.chart_not_numbers({ count: 1 }));
  find.click();
  const x = { col: UNITS, header: "units" };
  const y = { col: REVENUE, header: "revenue" };
  expect(notNumbers).toHaveBeenCalledExactlyOnceWith(SCATTER.source, [x, y]);
});

test("a bar chart's not-numbers count finds them in the column it sums, keeps the keys through a tally, and a count of none hides it and gives them to the window", async () => {
  const sum = { col: REVENUE, header: "revenue" };
  const sums: Chart = { ...FLUSH, plot: { t: "bars", by: { col: REGION, header: "region" }, sum } };
  const { layer, model } = shown(sums);
  model.heard = () => leftOut(heardOf("North"), { blank: 0, unparsed: 2 });
  await frame();
  const find = part(".chart-find");
  find.click();
  expect(notNumbers).toHaveBeenCalledExactlyOnceWith(FLUSH.source, [sum]);
  find.focus();
  layer.tallied(FLUSH.id);
  await frame();
  expect(part(".chart-find")).toBe(find);
  expect(document.activeElement).toBe(find);
  model.heard = () => heardOf("North");
  layer.tallied(FLUSH.id);
  await frame();
  expect(find.hidden).toBe(true);
  expect(said()).toBe(m.rows_count({ count: 1 }));
  expect(document.activeElement).toBe(first());
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

test("a move the layer takes stands the window there at the next draw", () => {
  const { layer, model } = shown(INSIDE);
  layer.move(INSIDE.id, FLUSH.place);
  layer.draw();
  expect(model.all[0]!.place).toBe(FLUSH.place);
  expect(drawn(first())).toStrictEqual(placed(FLUSH.place, ROOM));
});

test("an arrow moves a window and stores it at once, and Shift and an arrow resize it", () => {
  const { model } = shown(INSIDE);
  const from = placed(MOVED, ROOM);
  const moved = { ...from, x: from.x + NUDGE_PX };
  key("ArrowRight");
  expect(model.all[0]!.place).toStrictEqual(placeOf(moved, ROOM, MOVED));
  expect(drawn(first()).x).toBeCloseTo(moved.x);

  key("ArrowDown", { shiftKey: true });
  expect(model.all[0]!.place.height).toBe(from.height + NUDGE_PX);
  expect(drawn(first()).height).toBe(from.height + NUDGE_PX);
  expect(drawn(first()).width).toBe(from.width);
});

test("an arrow stops at the window, and a chord goes on to the shell", () => {
  shown(INSIDE);
  const shell = vi.fn();
  document.body.addEventListener("keydown", shell);
  expect(key("ArrowLeft").defaultPrevented).toBe(true);
  expect(shell).not.toHaveBeenCalled();

  expect(key("ArrowLeft", { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(key("a").defaultPrevented).toBe(false);
  expect(shell).toHaveBeenCalledTimes(2);
});

test("each arrow steps on from where the last one stored", () => {
  shown(INSIDE);
  key("ArrowRight");
  key("ArrowRight");
  expect(drawn(first()).x).toBeCloseTo(placed(MOVED, ROOM).x + 2 * NUDGE_PX);
});

test("arrows held past the room's edge leave the window on it", () => {
  const { model } = shown({ ...INSIDE, place: { ...MOVED, x: 1 } });
  key("ArrowRight");
  expect(model.all[0]!.place.x).toBe(1);
});

test("Escape gives the keys back to the grid, and goes no further", () => {
  shown(INSIDE);
  const shell = vi.fn();
  document.body.addEventListener("keydown", shell);
  expect(key("Escape").defaultPrevented).toBe(true);
  expect(leave).toHaveBeenCalledOnce();
  expect(shell).not.toHaveBeenCalled();
});

test("a window follows its head from where the pointer took hold, kept in the room", () => {
  shown(INSIDE);
  const from = placed(MOVED, ROOM);
  carry(head());
  expect(drawn(first())).toStrictEqual(dragged(from, STEP.x, STEP.y, ROOM));

  pointer("pointermove", head(), -FAR, -FAR);
  expect(drawn(first())).toStrictEqual({ ...from, x: 0, y: 0 });
});

test("a drop stores where the window stands, once, and nothing before it", () => {
  const { model } = shown(INSIDE);
  const to = dragged(placed(MOVED, ROOM), STEP.x, STEP.y, ROOM);
  carry(head());
  expect(model.move).not.toHaveBeenCalled();

  pointer("pointerup", head(), STEP.x, STEP.y);
  expect(model.move).toHaveBeenCalledOnce();
  expect(model.all[0]!.place).toStrictEqual(placeOf(to, ROOM, MOVED));
  expect(drawn(first()).x).toBeCloseTo(to.x);
});

test("a press takes the pointer and the keys, and leaves its mousedown to any popup", () => {
  shown(INSIDE);
  const focus = vi.spyOn(first(), "focus");
  const press = pointer("pointerdown", head());
  expect(press.defaultPrevented).toBe(false);
  expect(head().hasPointerCapture(POINTER)).toBe(true);
  expect(document.activeElement).toBe(first());
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

test("a click on a head stores nothing", () => {
  const { model } = shown(INSIDE);
  pointer("pointerdown", head());
  pointer("pointerup", head());
  expect(model.move).not.toHaveBeenCalled();
});

test("only the primary button takes hold of a window", () => {
  shown(INSIDE);
  pointer("pointerdown", head(), 0, 0, { button: SECONDARY });
  pointer("pointermove", head(), STEP.x, STEP.y);
  expect(drawn(first())).toStrictEqual(placed(MOVED, ROOM));
  expect(head().hasPointerCapture(POINTER)).toBe(false);
});

test("a head's buttons keep the pointer, and the window stays", () => {
  shown(INSIDE);
  const x = part(".round-x");
  pointer("pointerdown", x);
  pointer("pointermove", x, STEP.x, STEP.y);
  expect(head().hasPointerCapture(POINTER)).toBe(false);
  expect(drawn(first())).toStrictEqual(placed(MOVED, ROOM));
});

test("a drag over a room that shrinks keeps to the room as it is now", () => {
  const { model } = shown(INSIDE);
  const smaller = { w: 700, h: 400 };
  carry(head());
  roomIs(smaller);
  pointer("pointermove", head(), FAR, FAR);
  const to = {
    ...placed(MOVED, ROOM),
    x: smaller.w - MOVED.width,
    y: smaller.h - MOVED.height,
  };
  expect(drawn(first())).toStrictEqual(to);

  pointer("pointerup", head(), FAR, FAR);
  expect(model.all[0]!.place).toStrictEqual(placeOf(to, smaller, MOVED));
});

test("a room that tucks under a drag stores nothing, and the window tucks at the drop", () => {
  const { model } = shown(INSIDE);
  carry(head());
  roomIs(TUCKING);
  pointer("pointerup", head(), STEP.x, STEP.y);
  expect(model.move).not.toHaveBeenCalled();
  expect(drawn(first()).width).toBe(TUCKING.w);
});

test("a tucked head takes the keys and stores nothing, from the pointer or an arrow", () => {
  const { model } = shown(INSIDE);
  resize(TUCKING);
  pointer("pointerdown", head());
  expect(document.activeElement).toBe(first());
  expect(head().hasPointerCapture(POINTER)).toBe(false);

  pointer("pointermove", head(), STEP.x, STEP.y);
  pointer("pointerup", head(), STEP.x, STEP.y);
  key("ArrowRight");
  expect(model.move).not.toHaveBeenCalled();
});

test("Escape puts a drag back and keeps the window's keys, and the rest of it does nothing", () => {
  const { model } = shown(INSIDE);
  carry(head());
  key("Escape");
  expect(drawn(first())).toStrictEqual(placed(MOVED, ROOM));
  expect(leave).not.toHaveBeenCalled();

  pointer("pointermove", head(), -FAR, -FAR);
  pointer("pointerup", head(), -FAR, -FAR);
  expect(drawn(first())).toStrictEqual(placed(MOVED, ROOM));
  expect(model.move).not.toHaveBeenCalled();
});

test.each(["pointercancel", "lostpointercapture"])(
  "a pointer lost by %s puts the window back, and the next press takes hold",
  (lost) => {
    const { model } = shown(INSIDE);
    carry(head());
    pointer(lost, head());
    expect(drawn(first())).toStrictEqual(placed(MOVED, ROOM));
    expect(model.move).not.toHaveBeenCalled();

    carry(head());
    expect(drawn(first())).toStrictEqual(dragged(placed(MOVED, ROOM), STEP.x, STEP.y, ROOM));
  },
);

test("a draw leaves a window with the pointer that holds it", () => {
  const { layer } = shown(INSIDE);
  carry(head());
  const held = drawn(first());
  layer.draw();
  expect(drawn(first())).toStrictEqual(held);
});

test("an arrow does nothing to a window a pointer holds", () => {
  const { model } = shown(INSIDE);
  carry(head());
  key("ArrowRight");
  expect(model.move).not.toHaveBeenCalled();
  key("Escape");
  expect(drawn(first())).toStrictEqual(placed(MOVED, ROOM));
});

test("a second pointer changes nothing while the first holds the window", () => {
  const { model } = shown(INSIDE);
  const to = dragged(placed(MOVED, ROOM), STEP.x, STEP.y, ROOM);
  carry(head());
  const second = { pointerId: OTHER_POINTER };
  pointer("pointerdown", head(), 0, 0, second);
  pointer("pointermove", head(), FAR, FAR, second);
  pointer("pointerup", head(), FAR, FAR, second);
  pointer("pointercancel", head(), FAR, FAR, second);
  expect(drawn(first())).toStrictEqual(to);
  expect(model.move).not.toHaveBeenCalled();

  pointer("pointerup", head(), STEP.x, STEP.y);
  expect(model.move).toHaveBeenCalledOnce();
});

test("a capture moving from what a finger pressed to the head keeps the window held", () => {
  shown(INSIDE);
  const title = part(".chart-title");
  pointer("pointerdown", title);
  pointer("lostpointercapture", title);
  pointer("pointermove", head(), STEP.x, STEP.y);
  expect(drawn(first())).toStrictEqual(dragged(placed(MOVED, ROOM), STEP.x, STEP.y, ROOM));
});

test("the capture ending after a drop changes nothing", () => {
  const { model } = shown(INSIDE);
  carry(head());
  pointer("pointerup", head(), STEP.x, STEP.y);
  const { place } = model.all[0]!;
  pointer("lostpointercapture", head());
  expect(model.all[0]!.place).toBe(place);
  expect(model.move).toHaveBeenCalledOnce();
});

test.each<[string, string, number, number]>([
  ["the grip resizes both ways", ".chart-grip", STEP.x, STEP.y],
  ["the right edge resizes across", ".chart-edge-right", STEP.x, 0],
  ["the foot edge resizes down", ".chart-edge-foot", 0, STEP.y],
])("%s, and a drop stores it", (_name, zone, dx, dy) => {
  const { model } = shown(INSIDE);
  const to = stretched(placed(MOVED, ROOM), dx, dy, ROOM);
  carry(part(zone));
  expect(drawn(first())).toStrictEqual(to);
  expect(part(zone).hasPointerCapture(POINTER)).toBe(true);
  expect(document.activeElement).toBe(first());

  pointer("pointerup", part(zone), STEP.x, STEP.y);
  expect(model.all[0]!.place).toStrictEqual(placeOf(to, ROOM, MOVED));
});

test("a press in the grip's svg takes hold of the grip", () => {
  shown(INSIDE);
  pointer("pointerdown", grip().querySelector("svg")!);
  expect(grip().hasPointerCapture(POINTER)).toBe(true);
});

test("a resize holds at the least size and at the room's edge as it goes", () => {
  shown(INSIDE);
  const from = placed(MOVED, ROOM);
  pointer("pointerdown", grip());
  pointer("pointermove", grip(), -FAR, -FAR);
  expect(drawn(first())).toStrictEqual({ ...from, width: MIN_WIDTH, height: MIN_HEIGHT });

  pointer("pointermove", grip(), FAR, FAR);
  const most = { ...from, width: ROOM.w - from.x, height: ROOM.h - from.y };
  expect(drawn(first())).toStrictEqual(most);
});

test("Escape puts a resize back", () => {
  shown(INSIDE);
  carry(grip());
  key("Escape");
  expect(drawn(first())).toStrictEqual(placed(MOVED, ROOM));
});

test("a window with the keys stands over the others, with the windows in their order", () => {
  shown(INSIDE, OVER);
  const [under, over] = windows() as [HTMLElement, HTMLElement];
  const stack = (at: HTMLElement): number => Number(at.style.zIndex);

  under.focus();
  expect(stack(under)).toBeGreaterThan(stack(over));
  over.focus();
  expect(stack(over)).toBeGreaterThan(stack(under));
  under.focus();
  expect(stack(under)).toBeGreaterThan(stack(over));

  expect(windows()).toStrictEqual([under, over]);
  expect(document.activeElement).toBe(under);
});

test("a window stays over the others once it has given the keys back", () => {
  const { layer } = shown(INSIDE, OVER);
  const [under, over] = windows() as [HTMLElement, HTMLElement];
  over.focus();
  under.focus();
  under.blur();
  layer.draw();
  expect(Number(under.style.zIndex)).toBeGreaterThan(Number(over.style.zIndex));
});

test("a button in a window raises it as well", () => {
  shown(INSIDE, OVER);
  const [under, over] = windows() as [HTMLElement, HTMLElement];
  over.focus();
  under.querySelector<HTMLElement>(".round-x")!.focus();
  expect(Number(under.style.zIndex)).toBeGreaterThan(Number(over.style.zIndex));
});

test("a wheel on any part of a window goes to the sheet, and leaves the window and the keys", () => {
  const { model } = shown(INSIDE);
  const stood = drawn(first());
  for (const at of [head(), part(".chart-plot"), part(".chart-caption"), grip(), first()]) {
    wheelBy.mockClear();
    const event = turn(at, TURN);
    expect(wheelBy).toHaveBeenCalledExactlyOnceWith(TURN.deltaX, TURN.deltaY, TURN.deltaMode);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(drawn(first())).toEqual(stood);
  expect(model.move).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(first());
});

test("Ctrl+wheel on a window is left for zoom", () => {
  shown(INSIDE);
  const event = turn(part(".chart-plot"), TURN, { ctrlKey: true });
  expect(wheelBy).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

test("Shift and the wheel go along the sheet's rows, as they do over the grid", () => {
  shown(INSIDE);
  turn(part(".chart-plot"), DOWN, { shiftKey: true });
  expect(wheelBy).toHaveBeenCalledExactlyOnceWith(DOWN.deltaY, 0, WheelEvent.DOM_DELTA_PIXEL);
});

test.each([
  { way: "down", room: START, end: FOOT, wheel: DOWN },
  { way: "up", room: FOOT, end: START, wheel: UP },
  { way: "right", room: START, end: SIDE, wheel: RIGHT },
  { way: "left", room: SIDE, end: START, wheel: LEFT },
])("a scrollable takes a wheel $way while it has room, and then the sheet does", (ways) => {
  shown(INSIDE);
  const inner = scrollable(ways.room);
  const row = inner.appendChild(document.createElement("div"));

  // A wheel left uncancelled over a scrollable is the browser's to scroll.
  expect(turn(row, ways.wheel).defaultPrevented).toBe(false);
  expect(wheelBy).not.toHaveBeenCalled();

  Object.assign(inner, ways.end);
  expect(turn(row, ways.wheel).defaultPrevented).toBe(true);
  expect(wheelBy).toHaveBeenCalledOnce();
});

test("Shift and the wheel ask a scrollable for room along its rows, past any down it", () => {
  shown(INSIDE);
  const inner = scrollable(FOOT);
  expect(turn(inner, DOWN, { shiftKey: true }).defaultPrevented).toBe(false);

  Object.assign(inner, SIDE);
  expect(turn(inner, DOWN, { shiftKey: true }).defaultPrevented).toBe(true);
  expect(wheelBy).toHaveBeenCalledOnce();
});

test("a scrollable a fraction short of its end counts as there", () => {
  shown(INSIDE);
  // scrollTop is fractional at a zoom, where the sizes it adds to are rounded.
  turn(scrollable({ ...START, scrollTop: END - 0.5 }), DOWN);
  expect(wheelBy).toHaveBeenCalledOnce();
});

test("a wheel on a window's head goes to the sheet, with a scrollable in its plot", () => {
  shown(INSIDE);
  scrollable();
  turn(head(), DOWN);
  expect(wheelBy).toHaveBeenCalledOnce();
});
