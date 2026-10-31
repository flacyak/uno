/**
 * @fileoverview Where a chart's window draws in a room of any size, and what
 * its place keeps: the arithmetic in chart/place.ts, with no page.
 */

import { expect, test } from "vite-plus/test";

import type { ChartPlace } from "@document";

import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  placed,
} from "@renderer/chart/place";
import type { Room } from "@renderer/chart/place";

const ROOM: Room = { w: 1200, h: 800 };

/** A room of exactly one window of a new chart's size. */
const SNUG: Room = { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT };

/** A window of a new chart's size at the top left. */
const PLACE: ChartPlace = { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

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
