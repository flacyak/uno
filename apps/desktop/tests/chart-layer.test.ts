/**
 * @fileoverview The layer over the sheet: one window per chart, drawn from its
 * place in the room the sheet leaves, and placed again as the sheet resizes. A
 * window moves and resizes under a pointer and the arrow keys.
 *
 * happy-dom has no layout, so each test says what layout would measure, and
 * fires the resize a ResizeObserver would. Its pointer capture is bookkeeping
 * only, so each test sends a pointer's events to the element that holds it.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { Chart, ChartPlace } from "@document";
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

/** A chart over INSIDE. */
const OVER: Chart = { ...INSIDE, id: "c3" };

/** The name a workspace of several sources gives a window's source. */
const SOURCE = "sales-q3";

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

/** What the layer reads of a workspace's charts, for a test to change. */
interface Model {
  all: readonly Chart[];
  sourceLabel(source: string): string | undefined;
  move: (id: string, place: ChartPlace) => void;
}

const root = (): HTMLElement => document.querySelector<HTMLElement>("#charts")!;
const content = (): HTMLElement => document.querySelector<HTMLElement>("#content")!;
const scroller = (): HTMLElement => document.querySelector<HTMLElement>(".grid-scroll")!;
const gauge = (): HTMLElement => document.querySelector<HTMLElement>(".grid-scroll .chart-gauge")!;
const windows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".chart")];
const titles = (): Array<string | null> =>
  [...document.querySelectorAll(".chart-title")].map((title) => title.textContent);

/** The first window, and the parts of it a pointer takes hold of. */
const first = (): HTMLElement => windows()[0]!;
const part = (selector: string): HTMLElement => first().querySelector<HTMLElement>(selector)!;
const head = (): HTMLElement => part(".chart-head");
const grip = (): HTMLElement => part(".chart-grip");

/** Fires what a ResizeObserver on the sheet would. */
let resized: () => void;

/** What the layer calls to give the grid its keys back. */
const leave = vi.fn();

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
  const model: Model = {
    all: charts,
    sourceLabel: () => undefined,
    move: vi.fn((id: string, place: ChartPlace) => {
      model.all = model.all.map((chart) => (chart.id === id ? { ...chart, place } : chart));
    }),
  };
  return model;
}

/** A layer over a model holding `charts`, in ROOM, and that model. */
function shown(...charts: Chart[]): { layer: ChartLayer; model: Model } {
  const model = modelOf(...charts);
  const layer = new ChartLayer(root(), content(), leave);
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

beforeEach(() => {
  document.body.innerHTML = bodyMarkup();
  const grid = document.createElement("div");
  grid.className = "grid-scroll";
  content().append(grid);
  vi.stubGlobal("ResizeObserver", HeldObserver);
  leave.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  void setLocale(baseLocale, { reload: false });
});

test("the layer stays hidden until a workspace shows, and each chart has a window at its place", () => {
  const layer = new ChartLayer(root(), content(), leave);
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
