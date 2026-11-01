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

/** A room with space for every window at its place. */
const ROOM: Room = { w: 1000, h: 600 };

/** One chart flush to the room's right edge, and one in the middle of it. */
const FLUSH: Chart = BARS;
const INSIDE: Chart = { ...BARS, id: "c2", place: MOVED };

const root = (): HTMLElement => document.querySelector<HTMLElement>("#charts")!;
const windows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".chart")];

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

beforeEach(() => {
  document.body.innerHTML = bodyMarkup();
});

test("the layer stays hidden until a workspace shows, and each chart has a window at its place", () => {
  const layer = new ChartLayer(root());
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
