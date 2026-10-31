/**
 * @fileoverview Where a chart's window sits on the sheet. A place keeps the
 * window's size in CSS px and its x and y as fractions of the room beside and
 * below it, so a window draws from its place in a room of any size, and a
 * resize changes only what shows. This file is plain logic, so tests run it
 * directly.
 */

import type { ChartPlace } from "@document";

import { clamp } from "@renderer/grid/metrics";
import type { Press } from "@renderer/keys";

/** The narrowest a window draws: a title beside the head's four 20 px buttons. */
export const MIN_WIDTH = 240;

/** The shortest a window draws: about 110 px of plot under a 29 px head, over a 22 px caption. */
export const MIN_HEIGHT = 160;

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

/** A place's x or y at the room's left or top edge. */
const NEAR_EDGE = 0;

/** A place's x or y at the room's right or bottom edge. */
const FAR_EDGE = 1;

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

/** placed gives the rect a place draws in a room, whatever size the room is. */
export function placed(place: ChartPlace, room: Room): Rect {
  const width = fit(place.width, MIN_WIDTH, room.w);
  const height = fit(place.height, MIN_HEIGHT, room.h);
  return {
    x: place.x * (room.w - width),
    y: place.y * (room.h - height),
    width,
    height,
  };
}

/**
 * placeOf gives the place a rect stores in a room, held to the room and the
 * least size. A rect cannot show all of `was`, the place it came from, so a
 * side with no free px keeps its fraction, and a size the rect leaves as `was`
 * draws it stays stored. A tucked window stores nothing: its rect has no place.
 */
export function placeOf(rect: Rect, room: Room, was: ChartPlace): ChartPlace {
  const drawn = placed(was, room);
  const width = fit(rect.width, MIN_WIDTH, room.w);
  const height = fit(rect.height, MIN_HEIGHT, room.h);
  return {
    x: share(rect.x, room.w - width, was.x),
    y: share(rect.y, room.h - height, was.y),
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
 * only its `head` px head, at the room's full width, stacked from the top.
 */
export function tucked(index: number, head: number, room: Room): Rect {
  return { x: 0, y: index * head, width: room.w, height: head };
}

/**
 * fresh gives a new window's place when `n` charts are already there: at the
 * top of the half of the room away from the column selected at `selectedLeft`,
 * flush to that half's outer edge. A room under twice the window's width has
 * it cross the middle.
 */
export function fresh(n: number, selectedLeft: number, room: Room): ChartPlace {
  return {
    x: selectedLeft < room.w / 2 ? FAR_EDGE : NEAR_EDGE,
    y: share(n * CASCADE_PX, room.h - DEFAULT_HEIGHT, NEAR_EDGE),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}

/**
 * nudged gives the rect a press leaves: an arrow moves it, and with Shift
 * resizes it, up to the room's edge, as placeOf reads a rect past that edge as
 * a move. placeOf holds a move to the room. Any other key, or an arrow with
 * Ctrl, Alt or Meta, gives undefined, so that press can go on to the shell.
 */
export function nudged(rect: Rect, press: Press, room: Room): Rect | undefined {
  const arrow = ARROWS.get(press.key);
  if (arrow === undefined || press.ctrl || press.alt || press.meta) return undefined;
  const dx = arrow.dx * NUDGE_PX;
  const dy = arrow.dy * NUDGE_PX;
  if (!press.shift) return { ...rect, x: rect.x + dx, y: rect.y + dy };
  return {
    ...rect,
    width: Math.min(rect.width + dx, room.w - rect.x),
    height: Math.min(rect.height + dy, room.h - rect.y),
  };
}
