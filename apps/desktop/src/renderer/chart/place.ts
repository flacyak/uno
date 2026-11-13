/**
 * @fileoverview Where a chart's window sits on the sheet. A place keeps the
 * window's size in CSS px and its x and y as fractions of the room beside and
 * below it, so a window draws from its place in a room of any size, and a
 * resize changes only what shows. This file is plain logic, so tests run it
 * directly.
 */

import type { ChartPlace } from "@document";

import { clamp } from "@renderer/grid/metrics";
import type { ColumnSpan } from "@renderer/grid/view";
import type { Press } from "@renderer/keys";

/** The narrowest a window draws: a title beside the head's four 20 px buttons. */
export const MIN_WIDTH = 240;

/** The shortest a window draws: about 110 px of plot under a 29 px head, over a 22 px caption. */
export const MIN_HEIGHT = 160;

/**
 * The narrowest room that shows a head: 2 px of borders, 10 of padding, 8 of
 * gap, 20 of × and 4 of margin.
 */
export const HEAD_LEAST_WIDTH = 44;

/** A new window's width. Four across fill most of a full HD screen. */
export const DEFAULT_WIDTH = 420;

/** A new window's height. Four down fill most of a full HD screen. */
export const DEFAULT_HEIGHT = 260;

/**
 * How far down each chart already there puts a new one. This is under a head's
 * 29 px, so the title of the window underneath still shows.
 */
export const CASCADE_PX = 24;

/** How far a press of an arrow moves or resizes a window: fine enough to line two up. */
export const NUDGE_PX = 8;

/** A place's x or y at the room's left or top edge, and a rect's. */
const NEAR_EDGE = 0;

/** A place's x or y at the room's right or bottom edge. */
const FAR_EDGE = 1;

/** A place's x or y that puts a window's middle on the room's, in a room of any size. */
const MIDDLE = (NEAR_EDGE + FAR_EDGE) / 2;

/**
 * How many times the corner a room's free px must be for a new window on the
 * right to stand in by the corner and keep its x past MIDDLE, on the right half.
 */
export const STAND_IN_CORNERS = FAR_EDGE / (FAR_EDGE - MIDDLE);

/** The layer's box, which windows may fill, in CSS px. */
export interface Room {
  w: number;
  h: number;
}

/** A window's box in the room, in CSS px from the room's top left. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Which way each arrow steps. A Map, so a key named like an Object property
 * matches only an entry.
 */
const ARROWS: ReadonlyMap<string, { dx: number; dy: number }> = new Map([
  ["ArrowLeft", { dx: -1, dy: 0 }],
  ["ArrowRight", { dx: 1, dy: 0 }],
  ["ArrowUp", { dx: 0, dy: -1 }],
  ["ArrowDown", { dx: 0, dy: 1 }],
]);

/** fit gives one side of a window: `wanted`, from `least` up to `most`. */
function fit(wanted: number, least: number, most: number): number {
  return Math.min(Math.max(wanted, least), most);
}

/** share gives `offset` as a fraction of the `free` px, or `none` when no px are free. */
function share(offset: number, free: number, none: number): number {
  return free > 0 ? clamp(offset / free, FAR_EDGE) : none;
}

/**
 * along gives how far in a window stands at `fraction` of the `free` px, on the
 * nearest whole px, so its plot draws on whole px however a resize divides the
 * room. A room that ends between px keeps a window at its far edge flush to it.
 */
function along(fraction: number, free: number): number {
  return Math.min(Math.round(fraction * free), free);
}

/**
 * The window's × over a room, in the room's CSS px: how far the room's right
 * edge reaches under the strip the × keeps clear, the ×'s box, and how far a
 * window's own × stands in from its box's top and right edges.
 */
export interface Corner {
  reach: number;
  cross: Rect;
  inset: number;
}

/** A room with no × over it. */
export const NO_CORNER: Corner = {
  reach: 0,
  cross: { x: NEAR_EDGE, y: NEAR_EDGE, width: 0, height: 0 },
  inset: 0,
};

/**
 * cramped says whether `free` px beside a window are too few for it to stand
 * in by a `corner` that reaches into the room and keep its x past MIDDLE.
 */
function cramped(free: number, corner: number): boolean {
  return corner > 0 && free <= STAND_IN_CORNERS * corner;
}

/** stoodIn gives the x a window with `free` px beside it stands at, in by `corner`. */
function stoodIn(free: number, corner: number): number {
  return Math.round(free - corner);
}

/** clearWidth gives how wide a window of up to `width` px stands at the left edge, clear of `corner`. */
function clearWidth(room: Room, corner: number, width: number): number {
  return fit(Math.floor(room.w - corner), MIN_WIDTH, width);
}

/** placed gives the rect a place draws in a room, whatever size the room is. */
export function placed(place: ChartPlace, room: Room): Rect {
  const width = fit(place.width, MIN_WIDTH, room.w);
  const height = fit(place.height, MIN_HEIGHT, room.h);
  return {
    x: along(place.x, room.w - width),
    y: along(place.y, room.h - height),
    width,
    height,
  };
}

/**
 * shown gives the rect a place shows in a room under `corner`: where it draws,
 * unless that reaches into the corner. Then it stands clear as fresh stands a
 * new window: in by the corner, or where its free px are no more than
 * STAND_IN_CORNERS corners, at the left edge, as wide as the room leaves
 * clear up to its own width. The
 * place stays as it is, so a room that grows again shows the window where it
 * was put.
 */
export function shown(place: ChartPlace, room: Room, corner: Corner): Rect {
  const rect = placed(place, room);
  const reach = corner.reach;
  const free = room.w - rect.width;
  const inset = stoodIn(free, reach);
  if (reach <= 0 || rect.x <= inset) return rect;
  if (cramped(free, reach)) {
    return { ...rect, x: NEAR_EDGE, width: clearWidth(room, reach, rect.width) };
  }
  return { ...rect, x: inset };
}

/**
 * placeOf gives the place a rect stores in a room, held to the room and the
 * least size. A rect cannot show all of `was`, the place it came from, so a
 * side with no free px keeps its fraction, and a size or a side the rect leaves
 * as `was` shows it under `corner` stays stored. A rect stood in by the
 * corner, as far right as a window shows there, stores the far edge. A tucked
 * window stores nothing: its rect has no place.
 */
export function placeOf(
  rect: Rect,
  room: Room,
  was: ChartPlace,
  corner: Corner = NO_CORNER,
): ChartPlace {
  const drawn = shown(was, room, corner);
  const width = fit(rect.width, MIN_WIDTH, room.w);
  const height = fit(rect.height, MIN_HEIGHT, room.h);
  const keepsX = rect.x === drawn.x && width === drawn.width;
  const keepsY = rect.y === drawn.y && height === drawn.height;
  const free = room.w - width;
  const reach = corner.reach;
  const atCorner = reach > 0 && !cramped(free, reach) && rect.x === stoodIn(free, reach);
  const movedX = atCorner ? FAR_EDGE : share(rect.x, free, was.x);
  return {
    x: keepsX ? was.x : movedX,
    y: keepsY ? was.y : share(rect.y, room.h - height, was.y),
    width: width === drawn.width ? was.width : width,
    height: height === drawn.height ? was.height : height,
  };
}

/** tucks says whether a room is too small to draw any window whole. */
export function tucks(room: Room): boolean {
  return room.w < MIN_WIDTH || room.h < MIN_HEIGHT;
}

/**
 * tucked gives the rect of a room's `index`th window while the room tucks:
 * only its `head` px head, at the room's full width, stacked from the top. It
 * is one `border` taller than the head, whose band fills the box between its
 * borders, so the box's foot takes the place of the head's rule and lands on
 * the next window's top.
 */
export function tucked(index: number, head: number, border: number, room: Room): Rect {
  return { x: 0, y: index * head, width: room.w, height: head + border };
}

/** stackHeight gives how high `count` tucked windows stand, down to the last one's foot. */
export function stackHeight(count: number, head: number, border: number): number {
  return count * head + border;
}

/** overfull says whether `count` tucked windows do not fit in a room. */
export function overfull(count: number, head: number, border: number, room: Room): boolean {
  return count > 0 && stackHeight(count, head, border) > room.h;
}

/** thin says whether a room is too narrow to show a head. */
export function thin(room: Room): boolean {
  return room.w < HEAD_LEAST_WIDTH;
}

/**
 * fresh gives a new window's place when `n` charts are already there: at the
 * top of the half of the room away from the `selected` column, the half its
 * middle is not in, flush to that half's outer edge. A room under twice the
 * window's width has it cross the middle.
 *
 * `corner` is the window's × over the room. A new window on the right stands
 * in by as far as the room reaches under the ×, so its × stands clear. A
 * selected column that reaches past that inset is covered as little as the
 * corner allows: the window's × wins over it. It is stored as a fraction, so
 * it stands further in as the room grows and nearer the edge as it shrinks,
 * and stays on the right half.
 *
 * A room whose free px are no more than STAND_IN_CORNERS corners, where
 * standing in would bring the window's middle to the room's, as at 200% zoom
 * or in a 640 px window, has it stand at the left edge instead, as wide as the
 * room leaves clear of the corner, up to its own width. It covers the selected
 * column on either side, and at the left its × stays clear in a room of any size.
 */
export function fresh(
  n: number,
  selected: ColumnSpan,
  room: Room,
  corner: Corner = NO_CORNER,
): ChartPlace {
  const y = share(n * CASCADE_PX, room.h - DEFAULT_HEIGHT, NEAR_EDGE);
  const reach = corner.reach;
  const free = room.w - DEFAULT_WIDTH;
  if (cramped(free, reach)) {
    return {
      x: NEAR_EDGE,
      y,
      width: clearWidth(room, reach, DEFAULT_WIDTH),
      height: DEFAULT_HEIGHT,
    };
  }
  const middle = (selected.left + selected.right) / 2;
  return {
    x: middle < room.w / 2 ? share(free - reach, free, FAR_EDGE) : NEAR_EDGE,
    y,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}

/** dragged gives the rect a move of `dx` and `dy` leaves, stopped at the room's edges. */
export function dragged(rect: Rect, dx: number, dy: number, room: Room): Rect {
  return {
    ...rect,
    x: fit(rect.x + dx, NEAR_EDGE, room.w - rect.width),
    y: fit(rect.y + dy, NEAR_EDGE, room.h - rect.height),
  };
}

/**
 * stretched gives the rect a resize of `dx` and `dy` leaves, with its top left
 * still, from the least size up to the room's edge. It stops there because
 * placeOf reads a rect past that edge as a move.
 */
export function stretched(rect: Rect, dx: number, dy: number, room: Room): Rect {
  return {
    ...rect,
    width: fit(rect.width + dx, MIN_WIDTH, room.w - rect.x),
    height: fit(rect.height + dy, MIN_HEIGHT, room.h - rect.y),
  };
}

/**
 * nudged gives the rect a press leaves: an arrow moves it, and with Shift
 * resizes it. Any other key, or an arrow with Ctrl, Alt or Meta, gives
 * undefined, so that press can go on to the shell.
 */
export function nudged(rect: Rect, press: Press, room: Room): Rect | undefined {
  const arrow = ARROWS.get(press.key);
  if (arrow === undefined || press.ctrl || press.alt || press.meta) return undefined;
  const step = press.shift ? stretched : dragged;
  return step(rect, arrow.dx * NUDGE_PX, arrow.dy * NUDGE_PX, room);
}
