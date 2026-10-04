// Pure arithmetic for the row virtualiser in View. Every function here
// works on numbers alone.

/** Extra rows drawn past the viewport. */
export const OVERSCAN = 6;

/**
 * Maximum height of the scroller's content, in pixels. Browsers stop laying
 * out past about 33.5 million pixels. A sheet taller than this is "scaled":
 * the scrollbar position maps proportionally onto the sheet.
 */
export const MAX_SCROLL_PX = 15_000_000;

/** Sheet size figures used by layout. */
export interface Measure {
  /** Content height given to the scroller: the sheet height, capped. */
  real: number;
  /** Whether the sheet height exceeds the cap. */
  scaled: boolean;
  /** Maximum view position on the uncapped sheet. */
  vMax: number;
  /** Maximum scrollTop on the capped scroller. */
  rMax: number;
}

/** Computes the Measure for a sheet of `total` rows. */
export function measure(
  total: number,
  rowHeight: number,
  headH: number,
  viewport: number,
): Measure {
  const virtual = total * rowHeight + headH;
  const real = Math.min(virtual, MAX_SCROLL_PX);
  return {
    real,
    scaled: virtual > MAX_SCROLL_PX,
    vMax: Math.max(0, virtual - viewport),
    rMax: Math.max(0, real - viewport),
  };
}

/** Clamps a view position to [0, vMax]. */
export function clampTop(top: number, vMax: number): number {
  return Math.min(Math.max(0, top), vMax);
}

/**
 * Converts a scrollTop to a view position on the uncapped sheet. Returns 0
 * when `rMax` is 0 (the whole sheet fits in the viewport).
 *
 * An unscaled sheet gets the value back unchanged. Scaling by
 * rMax / vMax when they are equal can produce a value a hair off a row edge,
 * which ceil would then read as the next row.
 */
export function scrollerToTop(scrollTop: number, rMax: number, vMax: number): number {
  if (rMax === 0) return 0;
  return rMax === vMax ? scrollTop : (scrollTop / rMax) * vMax;
}

/** Converts a view position on the uncapped sheet to a scrollTop. Inverse
 * of scrollerToTop. */
export function topToScroller(top: number, vMax: number, rMax: number): number {
  if (vMax === 0) return 0;
  return vMax === rMax ? top : (top / vMax) * rMax;
}

/** Number of row elements needed: a screenful plus overscan, at most
 * `total`. */
export function poolSize(total: number, viewport: number, rowHeight: number): number {
  return Math.min(total, Math.ceil(viewport / rowHeight) + OVERSCAN);
}

/** Grows or shrinks `pool` to `want` elements. New elements come from `make`
 * and are appended to `parent`. */
export function fitPool<T extends Element>(
  pool: T[],
  want: number,
  make: () => T,
  parent: Element,
): void {
  while (pool.length < want) {
    const row = make();
    pool.push(row);
    parent.append(row);
  }
  while (pool.length > want) pool.pop()?.remove();
}

/** Index of the first row the pool draws, clamped so the pool stays full at
 * the end of the sheet. */
export function firstRow(total: number, pool: number, top: number, rowHeight: number): number {
  const maxFirst = Math.max(0, total - pool);
  return Math.min(maxFirst, Math.floor(top / rowHeight));
}

/** The table's `top` within the sizer, so row `first` lands where the view
 * is. Rounded to whole pixels; fractional offsets blur the text. */
export function tableOffset(seen: number, top: number, first: number, rowHeight: number): number {
  return Math.round(seen - (top - first * rowHeight));
}

/**
 * The smallest scroll position that shows the whole span [start, start+size)
 * in a window of `extent` starting at `at`. Returns undefined when it is
 * already visible. A span larger than the window is aligned to its start.
 */
export function spanIntoView(
  start: number,
  size: number,
  at: number,
  extent: number,
): number | undefined {
  if (start < at || size >= extent) return start === at ? undefined : start;
  if (start + size > at + extent) return start + size - extent;
  return undefined;
}

/** The smallest view position that shows the whole of `row`, or undefined
 * when it is already visible. */
export function intoView(
  row: number,
  rowHeight: number,
  top: number,
  height: number,
): number | undefined {
  return spanIntoView(row * rowHeight, rowHeight, top, height);
}

/** Where to place a row on screen. */
export type RowPlacement = "top" | "middle" | "bottom";

/** The view position that puts `row` at `where` on screen. May fall
 * outside [0, vMax]; the caller clamps. */
export function scrollTarget(
  row: number,
  rowHeight: number,
  height: number,
  where: RowPlacement,
): number {
  const y = row * rowHeight;
  if (where === "top") return y;
  if (where === "bottom") return y + rowHeight - height;
  return y + (rowHeight - height) / 2;
}

/** First and last rows fully on screen. */
export interface VisibleRange {
  top: number;
  bottom: number;
}

/** Computes the first and last rows fully on screen, clamped to the sheet. */
export function visibleRange(
  top: number,
  rowHeight: number,
  height: number,
  total: number,
): VisibleRange {
  const last = Math.max(0, total - 1);
  const first = Math.min(last, Math.ceil(top / rowHeight));
  const bottom = Math.floor((top + height) / rowHeight) - 1;
  return { top: first, bottom: Math.max(first, Math.min(last, bottom)) };
}

/** Rows moved by one page: a screenful minus one. */
export function pageSize(viewport: number, rowHeight: number): number {
  return Math.max(1, Math.floor(viewport / rowHeight) - 1);
}
