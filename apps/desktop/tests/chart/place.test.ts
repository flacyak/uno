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
  fresh,
  MIN_HEIGHT,
  MIN_WIDTH,
  placed,
  placeOf,
  tucked,
  tucks,
} from "@renderer/chart/place";
import type { Rect, Room } from "@renderer/chart/place";

const ROOM: Room = { w: 1200, h: 800 };

/** A room of exactly one window of a new chart's size. */
const SNUG: Room = { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT };

/** A window of a new chart's size at the top left. */
const PLACE: ChartPlace = { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

/** That window a quarter of the way across ROOM's free 780 x 540 px. */
const RECT: Rect = { x: 195, y: 135, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

/** The stylesheet's --row-h, a window head's height. */
const HEAD = 29;

/** A 640 px window with both side columns open at 168 and 250 px, less the 12 px --bar. */
const BOTH_SIDES_OPEN = 640 - 168 - 250 - 12;

/** The same window at 200% zoom, which halves its px, with the sidebar alone open. */
const ZOOMED = 640 / 2 - 168 - 12;

test("a window at the right and bottom edges stays there as the room narrows", () => {
  for (const room of [ROOM, { w: 640, h: 400 }, SNUG, { w: 300, h: 200 }]) {
    const rect = placed({ ...PLACE, x: 1, y: 1 }, room);
    expect(rect.x + rect.width).toBe(room.w);
    expect(rect.y + rect.height).toBe(room.h);
  }
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

test("a tucked window is its head, at the room's width, stacked in list order", () => {
  const room = { w: ZOOMED, h: ROOM.h };
  expect(tucked(2, HEAD, room)).toEqual({ x: 0, y: 2 * HEAD, width: room.w, height: HEAD });
});

test("a new window goes at the top of the half away from the selected column", () => {
  const right = placed(fresh(0, 0, ROOM), ROOM);
  expect([right.y, right.width, right.height]).toEqual([0, DEFAULT_WIDTH, DEFAULT_HEIGHT]);
  expect(right.x).toBeGreaterThanOrEqual(ROOM.w / 2);
  expect(fresh(0, ROOM.w / 2 - 1, ROOM).x).toBe(1);

  const left = placed(fresh(0, ROOM.w / 2, ROOM), ROOM);
  expect(left.x + left.width).toBeLessThanOrEqual(ROOM.w / 2);
});

test("each chart already there moves a new one down, as far as the room goes", () => {
  expect(placed(fresh(3, 0, ROOM), ROOM).y).toBeCloseTo(3 * CASCADE_PX);
  const room = { w: ROOM.w, h: DEFAULT_HEIGHT + CASCADE_PX };
  expect(placed(fresh(3, 0, room), room).y).toBe(CASCADE_PX);
});

test("a new window in a room of 0 px keeps its size at the top, as a record takes it", () => {
  const place = fresh(3, 0, { w: 0, h: 0 });
  expect([place.y, place.width, place.height]).toEqual([0, DEFAULT_WIDTH, DEFAULT_HEIGHT]);
  const plot = { t: "bars", by: { col: 0, header: "region" } };
  const chart = { id: "c1", source: "s1", plot, title: "", place, refresh: 0 };
  expect(parseChart("chart", chart).place).toEqual(place);
});

test.each<[string, Room]>([
  ["no room", { w: 0, h: 0 }],
  ["no width", { w: 0, h: ROOM.h }],
  ["no height", { w: ROOM.w, h: 0 }],
  ["a room of exactly one window", SNUG],
])("%s gives only numbers", (_name, room) => {
  const rect = placed({ ...PLACE, x: 0.5, y: 0.5 }, room);
  const boxes = [rect, placeOf(rect, room, PLACE), fresh(3, 0, room), tucked(3, HEAD, room)];
  expect(boxes.flatMap((box) => Object.values(box)).every(Number.isFinite)).toBe(true);
});
