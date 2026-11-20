/**
 * @fileoverview A histogram's columns, one per bin of a level of its spread,
 * as an over-time chart's. The span fills the plot's width, and the bins past
 * it stand beyond its edges, in a scroller that first shows the span.
 */

import type { Level } from "@tally";
import { el } from "@renderer/shell/util";
import { COLUMN_PITCH_LEAST, aside, sized, upOf, upward } from "./columns.ts";
import type { PlotRoom } from "./kind.ts";
import { BARS_INSET } from "./rows.ts";

/** The level a plot draws, and whether each bin of its span has COLUMN_PITCH_LEAST px. */
export interface Binned {
  level: Level;
  fits: boolean;
}

/** binnedIn gives the finest of `levels` whose span's bins each get COLUMN_PITCH_LEAST px of `room`, or else the coarsest. */
export function binnedIn(levels: readonly Level[], room: PlotRoom): Binned | undefined {
  const fits = (level: Level): boolean =>
    level.spans * COLUMN_PITCH_LEAST <= room.width - 2 * BARS_INSET - aside(upOf(level.rows), room);
  const level = levels.find(fits) ?? levels.at(-1);
  return level === undefined ? undefined : { level, fits: fits(level) };
}

/**
 * histogram draws `level` as a column of rows per bin, from zero. The bins are
 * as much wider than their scroller as they are more than the span's, and
 * --span-at says where the span starts, in scroller widths, for fitHistogram.
 */
export function histogram({ level, fits }: Binned): HTMLElement {
  const box = el("div", "chart-histogram");
  const up = upOf(level.rows);
  const { span, grid, labels } = upward(up);
  const periods = el("div", "chart-periods");
  periods.style.width = `${(level.rows.length / level.spans) * 100}%`;
  periods.append(grid);
  for (const rows of level.rows) {
    const slot = el("div", "chart-period");
    slot.style.setProperty("--share", `${rows / span}`);
    slot.append(el("div", "chart-column"));
    periods.append(slot);
  }
  const along = el("div", "chart-along chart-scrolls themed-bar");
  // The plot has the keys, so its scroller is no stop of its own.
  along.tabIndex = -1;
  along.append(periods);
  sized(box, up, fits);
  box.style.setProperty("--span-at", `${level.at / level.spans}`);
  box.append(labels, along);
  return box;
}

/** fitHistogram scrolls a drawn histogram to its span, and ends its y axis where its bins do, over the bar. */
export function fitHistogram(drawn: HTMLElement): void {
  const along = drawn.querySelector<HTMLElement>(".chart-along");
  const periods = along?.firstElementChild;
  if (!along || !periods) return;
  const at = Number(drawn.style.getPropertyValue("--span-at"));
  along.scrollLeft = at * along.clientWidth;
  const below = along.getBoundingClientRect().bottom - periods.getBoundingClientRect().bottom;
  drawn.style.setProperty("--below", `${below}px`);
}
