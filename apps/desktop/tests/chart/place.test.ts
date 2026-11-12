/**
 * @fileoverview Where a chart's window draws in a room of any size, and what
 * its place keeps: the arithmetic in chart/place.ts, with no page.
 */

import { expect, test } from "vite-plus/test";

import { parseChart } from "@document";
import type { ChartPlace } from "@document";

import {
  CASCADE_PX,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  dragged,
  fresh,
  HEAD_LEAST_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  nudged,
  NUDGE_PX,
  overfull,
  placed,
  placeOf,
  shown,
  stackHeight,
  stretched,
  STAND_IN_CORNERS,
  thin,
  tucked,
  tucks,
} from "@renderer/chart/place";
import type { Rect, Room } from "@renderer/chart/place";
import type { ColumnSpan } from "@renderer/grid/view";
import type { Press } from "@renderer/keys";

const ROOM: Room = { w: 1200, h: 800 };

/** A grid column's width at zoom 1, as the sales export's channel draws. */
const COLUMN_WIDTH = 146;

/** A column `left` px into the room. */
const columnAt = (left: number): ColumnSpan => ({ left, right: left + COLUMN_WIDTH });

/** How far a column across the room's middle reaches past it on its shorter side. */
const PAST_MIDDLE = 2;

/** How far an 1100 px window's room reaches under its ×: `--corner`'s 34 px past the 12 px bar. */
const CORNER = 22;

/** The 1100 px window's room at 200% zoom with the panel closed, under DEFAULT_WIDTH. */
const ZOOMED_ROOM_WIDTH = 371;

/** A room of exactly one window of a new chart's size. */
const SNUG: Room = { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT };

/** A window of a new chart's size at the top left. */
const PLACE: ChartPlace = { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

/** That window a quarter of the way across ROOM's free 780 x 540 px. */
const RECT: Rect = { x: 195, y: 135, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

/** The stylesheet's --row-h, a window head's height. */
const HEAD = 29;

/** A window's border at 100% zoom. */
const BORDER = 1;

/** A 640 px window with both side columns open at 168 and 250 px, less the 12 px --bar. */
const BOTH_SIDES_OPEN = 640 - 168 - 250 - 12;

/** The same window at 200% zoom, which halves its px, with the sidebar alone open. */
const ZOOMED = 640 / 2 - 168 - 12;

/** A place a move leaves at a share of the free px, which a resize can put between px. */
const MOVED: ChartPlace = { ...PLACE, x: 0.4, y: 0.6 };

/** ROOM with a px taken off each way, which leaves MOVED's share between px. */
const RESIZED: Room = { w: ROOM.w - 1, h: ROOM.h - 1 };

/** What a zoom can leave a room past a whole px. */
const HALF_PX = 0.5;

/** A press of `key`, as a window's keydown hands it over. */
function press(key: string, more: Partial<Press> = {}): Press {
  return { key, ctrl: false, alt: false, meta: false, shift: false, repeat: false, ...more };
}

/** The place one press leaves a window with: placed, nudged, then placeOf. */
function pressed(place: ChartPlace, key: Press, room: Room): ChartPlace {
  const rect = nudged(placed(place, room), key, room);
  return rect === undefined ? place : placeOf(rect, room, place);
}

test("a window at the right and bottom edges stays there as the room narrows", () => {
  for (const room of [ROOM, { w: 640, h: 400 }, SNUG, { w: 300, h: 200 }]) {
    const rect = placed({ ...PLACE, x: 1, y: 1 }, room);
    expect(rect.x + rect.width).toBe(room.w);
    expect(rect.y + rect.height).toBe(room.h);
  }
});

test("a window stands on whole px as the room resizes, and flush to an edge between px", () => {
  const { x, y } = placed(MOVED, RESIZED);
  expect([x, y].every(Number.isInteger)).toBe(true);
  const zoomed = { w: ROOM.w + HALF_PX, h: ROOM.h + HALF_PX };
  const flush = placed({ ...PLACE, x: 1, y: 1 }, zoomed);
  expect([flush.x + flush.width, flush.y + flush.height]).toEqual([zoomed.w, zoomed.h]);
});

test("a press keeps the share of a side it leaves where it stands", () => {
  expect(pressed(MOVED, press("ArrowRight"), RESIZED).y).toBe(MOVED.y);
  expect(pressed({ ...MOVED, y: 1 }, press("ArrowDown"), RESIZED).x).toBe(MOVED.x);
});

test("a place draws at no less than the least size, and no more than the room", () => {
  const small = placed({ ...PLACE, width: 1, height: 1 }, ROOM);
  expect([small.width, small.height]).toEqual([MIN_WIDTH, MIN_HEIGHT]);
  const large = placed({ ...PLACE, x: 1, y: 1, width: 5000, height: 5000 }, ROOM);
  expect(large).toEqual({ x: 0, y: 0, width: ROOM.w, height: ROOM.h });
});

test("in a room under the least size the room wins, so the window stays inside it", () => {
  const room = { w: MIN_WIDTH / 2, h: MIN_HEIGHT / 2 };
  const rect = placed({ ...PLACE, x: 1, y: 1 }, room);
  expect(rect).toEqual({ x: 0, y: 0, width: room.w, height: room.h });
});

test("a place comes back from the rect it draws, in every room", () => {
  const place = { ...PLACE, x: 0.25, y: 0.75 };
  for (const room of [ROOM, { w: 640, h: 400 }, SNUG, { w: 300, h: ROOM.h }, { w: 300, h: 200 }]) {
    const back = placeOf(placed(place, room), room, place);
    expect(back.x).toBeCloseTo(place.x);
    expect(back.y).toBeCloseTo(place.y);
    expect([back.width, back.height]).toEqual([place.width, place.height]);
  }
});

test("a rect changed on one side keeps what the room hid on the other", () => {
  const place = { ...PLACE, x: 1 };
  const room = { w: 300, h: ROOM.h };
  const rect = placed(place, room);
  const moved = placeOf({ ...rect, y: CASCADE_PX }, room, place);
  expect([moved.x, moved.width]).toEqual([place.x, place.width]);
  const resized = placeOf({ ...rect, height: MIN_HEIGHT }, room, place);
  expect(resized).toEqual({ ...place, height: MIN_HEIGHT });
});

test("a rect pushed past an edge keeps to it", () => {
  expect(placeOf({ ...RECT, x: -1 }, ROOM, PLACE).x).toBe(0);
  expect(placeOf({ ...RECT, y: -1 }, ROOM, PLACE).y).toBe(0);
  expect(placeOf({ ...RECT, x: ROOM.w }, ROOM, PLACE).x).toBe(1);
  expect(placeOf({ ...RECT, y: ROOM.h }, ROOM, PLACE).y).toBe(1);
});

test("a rect pushed under the least size stores it, with its corner where it was", () => {
  const pushed = { ...RECT, width: MIN_WIDTH - 1, height: MIN_HEIGHT - 1 };
  const back = placed(placeOf(pushed, ROOM, PLACE), ROOM);
  expect(back).toEqual({ ...RECT, width: MIN_WIDTH, height: MIN_HEIGHT });
});

test("a room tucks from one px under the least size, as a 0 px or zoomed sheet does", () => {
  expect(tucks({ w: MIN_WIDTH, h: MIN_HEIGHT })).toBe(false);
  expect(tucks({ w: MIN_WIDTH - 1, h: MIN_HEIGHT })).toBe(true);
  expect(tucks({ w: MIN_WIDTH, h: MIN_HEIGHT - 1 })).toBe(true);
  for (const w of [0, BOTH_SIDES_OPEN, ZOOMED]) expect(tucks({ w, h: ROOM.h })).toBe(true);
});

test("a room holds tucked heads up to its foot", () => {
  const count = 3;
  const stack = count * HEAD + BORDER;
  expect(overfull(count, HEAD, BORDER, { w: ROOM.w, h: stack })).toBe(false);
  expect(overfull(count, HEAD, BORDER, { w: ROOM.w, h: stack - 1 })).toBe(true);
  expect(overfull(0, HEAD, BORDER, { w: 0, h: 0 })).toBe(false);
});

test("a room shows a head from the head's least width up", () => {
  expect(thin({ w: HEAD_LEAST_WIDTH - 1, h: ROOM.h })).toBe(true);
  expect(thin({ w: HEAD_LEAST_WIDTH, h: ROOM.h })).toBe(false);
});

test("a tucked window is its head, at the room's width, stacked in list order", () => {
  const room = { w: ZOOMED, h: ROOM.h };
  const rect = tucked(2, HEAD, BORDER, room);
  expect(rect).toEqual({ x: 0, y: 2 * HEAD, width: room.w, height: HEAD + BORDER });
  expect(tucked(3, HEAD, BORDER, room).y).toBe(rect.y + rect.height - BORDER);
  expect(stackHeight(3, HEAD, BORDER)).toBe(rect.y + rect.height);
});

test("a new window goes at the top of the half away from the selected column", () => {
  const right = placed(fresh(0, columnAt(0), ROOM), ROOM);
  expect([right.y, right.width, right.height]).toEqual([0, DEFAULT_WIDTH, DEFAULT_HEIGHT]);
  expect(right.x).toBeGreaterThanOrEqual(ROOM.w / 2);
  expect(fresh(0, columnAt(ROOM.w / 2 - COLUMN_WIDTH / 2 - 1), ROOM).x).toBe(1);

  const left = placed(fresh(0, columnAt(ROOM.w / 2), ROOM), ROOM);
  expect(left.x + left.width).toBeLessThanOrEqual(ROOM.w / 2);
});

test("a column across the middle sends a new window to the half it has less of", () => {
  const half = ROOM.w / 2;
  expect(fresh(0, columnAt(half - PAST_MIDDLE), ROOM).x).toBe(0);
  expect(fresh(0, columnAt(half - COLUMN_WIDTH + PAST_MIDDLE), ROOM).x).toBe(1);
});

test("a new window on the right stands as far in as the room reaches under the window's ×", () => {
  const inset = (place: ChartPlace, room: Room): number => {
    const at = placed(place, room);
    return room.w - at.x - at.width;
  };
  const place = fresh(0, columnAt(0), ROOM, CORNER);
  expect(inset(place, ROOM)).toBeCloseTo(CORNER);
  // The inset is a share of the free px, so a narrower room has it nearer the
  // edge, and the window stands on a whole px of it.
  const half = { ...ROOM, w: ROOM.w / 2 };
  const share = (half.w - DEFAULT_WIDTH) / (ROOM.w - DEFAULT_WIDTH);
  expect(inset(place, half)).toBe(Math.round(CORNER * share));
});

test("past the band, the window's × wins over a selected column reaching into the inset", () => {
  const upper = DEFAULT_WIDTH + STAND_IN_CORNERS * CORNER;
  // Past the band; where the first column fills the free px; and where it
  // reaches into the inset, from its least to the last px before it clears it.
  const widths = [
    upper + 1,
    DEFAULT_WIDTH + COLUMN_WIDTH,
    DEFAULT_WIDTH + COLUMN_WIDTH + 1,
    DEFAULT_WIDTH + CORNER + COLUMN_WIDTH - 1,
    DEFAULT_WIDTH + CORNER + COLUMN_WIDTH,
  ];
  for (const w of widths) {
    const room = { ...ROOM, w };
    const at = placed(fresh(0, columnAt(0), room, CORNER), room);
    expect(w - at.x - at.width).toBe(CORNER);
  }
  const reaching = { left: 0, right: ROOM.w - DEFAULT_WIDTH - CORNER / 2 };
  expect(placed(fresh(0, reaching, ROOM, CORNER), ROOM).x).toBeCloseTo(
    ROOM.w - DEFAULT_WIDTH - CORNER,
  );
});

test("a room too narrow for a new window to stand in by the corner has it stand clear at the left", () => {
  // The band: the least room a new window stands clear in at its own width, and the
  // most where standing in by the corner would bring its middle to the room's.
  const lower = DEFAULT_WIDTH + CORNER;
  const upper = DEFAULT_WIDTH + STAND_IN_CORNERS * CORNER;
  // The zoomed room, one that ends between px, 1 px under the band, its edges and its middle.
  const widths = [
    ZOOMED_ROOM_WIDTH,
    ZOOMED_ROOM_WIDTH + 0.5,
    lower - 1,
    lower,
    (lower + upper) / 2,
    upper,
  ];
  for (const w of widths) {
    const room = { ...ROOM, w };
    for (const column of [columnAt(0), columnAt(w - COLUMN_WIDTH)]) {
      const at = placed(fresh(0, column, room, CORNER), room);
      expect([at.x, at.width]).toEqual([0, Math.min(DEFAULT_WIDTH, Math.floor(w - CORNER))]);
    }
    // With no × over the room, a new window goes flush right as before, filling a room under its width.
    const bare = placed(fresh(0, columnAt(0), room), room);
    expect([bare.x + bare.width, bare.width]).toEqual([w, Math.min(w, DEFAULT_WIDTH)]);
  }
  // At the left edge, the × stays clear in a room of any size.
  expect(placed(fresh(0, columnAt(0), { ...ROOM, w: upper }, CORNER), ROOM).x).toBe(0);
});

test("a window reaching under the window's × shows stood in by the corner, and stores where it was", () => {
  const far = { ...PLACE, x: 1, y: 1 };
  const at = shown(far, ROOM, CORNER);
  expect(at).toEqual({ ...placed(far, ROOM), x: ROOM.w - DEFAULT_WIDTH - CORNER });
  // A rect as it shows stores the place it came from, and one moved down keeps its x.
  expect(placeOf(at, ROOM, far, CORNER)).toEqual(far);
  expect(placeOf({ ...at, y: CASCADE_PX }, ROOM, far, CORNER).x).toBe(far.x);
  // A drop in the corner stores where it ended, and shows clear of it.
  const dropped = placeOf({ ...RECT, x: ROOM.w - DEFAULT_WIDTH }, ROOM, PLACE, CORNER);
  expect(shown(dropped, ROOM, CORNER).x).toBe(at.x);
  // A rect stopped by the corner, as an arrow leaves it, stores the far edge, where it shows.
  expect(placeOf({ ...RECT, x: at.x }, ROOM, PLACE, CORNER).x).toBe(1);
  expect(placeOf({ ...RECT, x: at.x - NUDGE_PX }, ROOM, PLACE, CORNER).x).toBeLessThan(1);
});

test("a window reaching under the window's × in a room too narrow to stand in shows clear at the left", () => {
  const upper = DEFAULT_WIDTH + STAND_IN_CORNERS * CORNER;
  for (const w of [ZOOMED_ROOM_WIDTH, ZOOMED_ROOM_WIDTH + HALF_PX, upper]) {
    const room = { ...ROOM, w };
    const at = shown({ ...PLACE, x: 1 }, room, CORNER);
    expect([at.x, at.width]).toEqual([0, Math.min(DEFAULT_WIDTH, Math.floor(w - CORNER))]);
  }
});

test("a window clear of the corner, or under no ×, shows where it draws", () => {
  // A new window stands in exactly by the corner, in rooms past the band and between px.
  for (const w of [ROOM.w, DEFAULT_WIDTH + STAND_IN_CORNERS * CORNER + 1, ROOM.w + HALF_PX]) {
    const room = { ...ROOM, w };
    const place = fresh(0, columnAt(0), room, CORNER);
    expect(shown(place, room, CORNER)).toEqual(placed(place, room));
  }
  // One inserted in a narrower room stands further in once the room grows.
  const narrower = fresh(0, columnAt(0), { ...ROOM, w: ROOM.w / 2 }, CORNER);
  expect(shown(narrower, ROOM, CORNER)).toEqual(placed(narrower, ROOM));
  for (const place of [PLACE, MOVED])
    expect(shown(place, ROOM, CORNER)).toEqual(placed(place, ROOM));
  const far = { ...PLACE, x: 1 };
  expect(shown(far, { ...ROOM, w: ZOOMED_ROOM_WIDTH }, 0)).toEqual(
    placed(far, { ...ROOM, w: ZOOMED_ROOM_WIDTH }),
  );
});

test("a window inserted in a wider room shows stood in by the corner in a narrower one", () => {
  const place = fresh(0, columnAt(0), ROOM, CORNER);
  const room = { ...ROOM, w: ROOM.w / 2 };
  const at = shown(place, room, CORNER);
  expect(room.w - at.x - at.width).toBe(CORNER);
});

test("each chart already there moves a new one down, as far as the room goes", () => {
  expect(placed(fresh(3, columnAt(0), ROOM), ROOM).y).toBeCloseTo(3 * CASCADE_PX);
  const room = { w: ROOM.w, h: DEFAULT_HEIGHT + CASCADE_PX };
  expect(placed(fresh(3, columnAt(0), room), room).y).toBe(CASCADE_PX);
});

test("a new window in a room of 0 px keeps its size at the top, as a record takes it", () => {
  const place = fresh(3, columnAt(0), { w: 0, h: 0 });
  expect([place.y, place.width, place.height]).toEqual([0, DEFAULT_WIDTH, DEFAULT_HEIGHT]);
  const plot = { t: "bars", by: { col: 0, header: "region" } };
  const chart = { id: "c1", source: "s1", plot, title: "", place, refresh: 0 };
  expect(parseChart("chart", chart).place).toEqual(place);
});

test.each<[string, Partial<Rect>, Partial<Rect>]>([
  ["ArrowLeft", { x: RECT.x - NUDGE_PX }, { width: RECT.width - NUDGE_PX }],
  ["ArrowRight", { x: RECT.x + NUDGE_PX }, { width: RECT.width + NUDGE_PX }],
  ["ArrowUp", { y: RECT.y - NUDGE_PX }, { height: RECT.height - NUDGE_PX }],
  ["ArrowDown", { y: RECT.y + NUDGE_PX }, { height: RECT.height + NUDGE_PX }],
])("%s moves a window, and resizes it with Shift", (key, moved, resized) => {
  expect(nudged(RECT, press(key), ROOM)).toEqual({ ...RECT, ...moved });
  expect(nudged(RECT, press(key, { shift: true }), ROOM)).toEqual({ ...RECT, ...resized });
});

test("any other key, or a chord on an arrow, leaves a window to the shell", () => {
  expect(nudged(RECT, press("a"), ROOM)).toBeUndefined();
  expect(nudged(RECT, press("constructor", { shift: true }), ROOM)).toBeUndefined();
  for (const chord of [{ ctrl: true }, { alt: true }, { meta: true }]) {
    expect(nudged(RECT, press("ArrowLeft", chord), ROOM)).toBeUndefined();
  }
});

test("an arrow held at the edge or at the least size leaves the window where it is", () => {
  const corner = { ...PLACE, x: 1, y: 1 };
  for (const shift of [false, true]) {
    expect(pressed(corner, press("ArrowRight", { shift }), ROOM)).toEqual(corner);
    expect(pressed(corner, press("ArrowDown", { shift }), ROOM)).toEqual(corner);
  }
  const least = { ...PLACE, width: MIN_WIDTH, height: MIN_HEIGHT };
  expect(pressed(least, press("ArrowLeft", { shift: true }), ROOM)).toEqual(least);
  expect(pressed(least, press("ArrowUp", { shift: true }), ROOM)).toEqual(least);
});

test("Shift and an arrow near the edge grow a window to it, with its corner still", () => {
  const gap = NUDGE_PX / 2;
  const rect = { ...RECT, x: ROOM.w - RECT.width - gap, y: ROOM.h - RECT.height - gap };
  const wider = nudged(rect, press("ArrowRight", { shift: true }), ROOM);
  expect(wider).toEqual({ ...rect, width: RECT.width + gap });
  const taller = nudged(rect, press("ArrowDown", { shift: true }), ROOM);
  expect(taller).toEqual({ ...rect, height: RECT.height + gap });
});

test("a move in a room the window fills keeps the place's other side", () => {
  const place = { ...PLACE, x: 1 };
  const room = { w: DEFAULT_WIDTH, h: ROOM.h };
  const moved = pressed(place, press("ArrowDown"), room);
  expect(moved).toEqual({ ...place, y: NUDGE_PX / (room.h - DEFAULT_HEIGHT) });
});

test("a drag moves a window by the pointer's px, and keeps its size", () => {
  expect(dragged(RECT, 30, -20, ROOM)).toEqual({ ...RECT, x: RECT.x + 30, y: RECT.y - 20 });
});

test("a drag past an edge stands the window on it", () => {
  const far = ROOM.w + ROOM.h;
  const right = ROOM.w - RECT.width;
  const foot = ROOM.h - RECT.height;
  expect(dragged(RECT, -far, -far, ROOM)).toEqual({ ...RECT, x: 0, y: 0 });
  expect(dragged(RECT, far, far, ROOM)).toEqual({ ...RECT, x: right, y: foot });
});

test("a stretch resizes a window by the pointer's px, with its corner still", () => {
  const wider = { ...RECT, width: RECT.width + 30, height: RECT.height - 20 };
  expect(stretched(RECT, 30, -20, ROOM)).toEqual(wider);
});

test("a stretch stops at the least size and at the room's edge", () => {
  const far = ROOM.w + ROOM.h;
  const least = { ...RECT, width: MIN_WIDTH, height: MIN_HEIGHT };
  expect(stretched(RECT, -far, -far, ROOM)).toEqual(least);
  const most = { ...RECT, width: ROOM.w - RECT.x, height: ROOM.h - RECT.y };
  expect(stretched(RECT, far, far, ROOM)).toEqual(most);
});

test("a stretch to the room's edge stores where it stopped, as a move past it would not", () => {
  const far = ROOM.w + ROOM.h;
  const rect = stretched(RECT, far, far, ROOM);
  expect(placed(placeOf(rect, ROOM, PLACE), ROOM)).toEqual(rect);
});

test.each<[string, Room]>([
  ["no room", { w: 0, h: 0 }],
  ["no width", { w: 0, h: ROOM.h }],
  ["no height", { w: ROOM.w, h: 0 }],
  ["a room of exactly one window", SNUG],
])("%s gives only numbers", (_name, room) => {
  const rect = placed({ ...PLACE, x: 0.5, y: 0.5 }, room);
  const boxes = [
    rect,
    placeOf(rect, room, PLACE),
    fresh(3, columnAt(0), room),
    tucked(3, HEAD, BORDER, room),
  ];
  expect(boxes.flatMap((box) => Object.values(box)).every(Number.isFinite)).toBe(true);
});
