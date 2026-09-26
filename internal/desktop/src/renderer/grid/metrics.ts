// The virtualiser's arithmetic, pulled out of View so it can be checked
// without a display. Nothing here touches the DOM: every function is a
// question about numbers, and View decides what to do with the answer.

/** Rows drawn beyond the viewport, so a fast scroll does not show a gap before
 * the next frame catches up. */
export const OVERSCAN = 6;

/**
 * The tallest the scroller's content is allowed to be.
 *
 * Browsers stop laying out past a limit -- about 33.5 million pixels in
 * Chromium, less in Firefox -- so a sheet taller than this scrolls by
 * proportion: the scrollbar maps onto the rows, and the wheel and the keys still
 * move by rows.
 */
export const MAX_SCROLL_PX = 15_000_000;

/** What layout needs to know about the sheet's size before it draws anything. */
export interface Measure {
  /** The scroller's actual content height: the sheet's height, capped. */
  real: number;
  /** Whether the sheet is past the cap, and so scrolls by proportion. */
  scaled: boolean;
  /** How far the view can move down the uncapped sheet. */
  vMax: number;
  /** How far the scrollbar can move down the capped one. */
  rMax: number;
}

/** measure sizes the sheet against the cap. `total` is the row count. */
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

/** clampTop keeps a view position on the uncapped sheet, between its top and
 * how far down it can go. */
export function clampTop(top: number, vMax: number): number {
  return Math.min(Math.max(0, top), vMax);
}

/**
 * scrollerToTop reads where the scrollbar sits, above the cap, and answers
 * where that puts the view on the uncapped sheet. `rMax` is zero exactly when
 * the whole sheet fits without scrolling, and the answer is then the top,
 * rather than a division by zero.
 */
export function scrollerToTop(scrollTop: number, rMax: number, vMax: number): number {
  return rMax === 0 ? 0 : (scrollTop / rMax) * vMax;
}

/** topToScroller is the inverse: where the scrollbar should sit, above the
 * cap, for the view to be at `top` on the uncapped sheet. */
export function topToScroller(top: number, vMax: number, rMax: number): number {
  return vMax === 0 ? 0 : (top / vMax) * rMax;
}

/** poolSize is how many row elements the pool needs: a screenful, plus the
 * overscan, never more than the sheet has rows. */
export function poolSize(total: number, viewport: number, rowHeight: number): number {
  return Math.min(total, Math.ceil(viewport / rowHeight) + OVERSCAN);
}

/** firstRow is the first row the pool draws, clamped so the last screenful
 * stays full at the very end of the sheet. */
export function firstRow(total: number, pool: number, top: number, rowHeight: number): number {
  const maxFirst = Math.max(0, total - pool);
  return Math.min(maxFirst, Math.floor(top / rowHeight));
}

/**
 * tableOffset is how far the table sits above the scroller's top, so it moves
 * as one element rather than each row being positioned. Whole pixels, because
 * at millions of pixels down a fraction draws the text blurred.
 */
export function tableOffset(seen: number, top: number, first: number, rowHeight: number): number {
  return Math.round(seen - (top - first * rowHeight));
}

/**
 * intoView is the least scroll that puts `row` wholly on screen, or undefined
 * when it already is, so the caller does no arithmetic of its own.
 */
export function intoView(
  row: number,
  rowHeight: number,
  top: number,
  height: number,
): number | undefined {
  const rowTop = row * rowHeight;
  if (rowTop < top) return rowTop;
  if (rowTop + rowHeight > top + height) return rowTop + rowHeight - height;
  return undefined;
}

/** Where a row lands on screen: at the top, centred, or at the bottom. */
export type RowPlacement = "top" | "middle" | "bottom";

/** scrollTarget is the view position that puts `row` at `where` on screen,
 * before clamping to the sheet's ends. */
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

/** The first and last rows wholly on screen. */
export interface VisibleRange {
  top: number;
  bottom: number;
}

/** visibleRange is the rows H, M and L land on, clamped to the sheet. */
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

/** pageSize is how many rows a page moves: a screen, less one to keep in sight. */
export function pageSize(viewport: number, rowHeight: number): number {
  return Math.max(1, Math.floor(viewport / rowHeight) - 1);
}
