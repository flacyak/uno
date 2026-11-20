/**
 * @fileoverview A histogram's columns, one per bin of a level of its spread,
 * as an over-time chart's. The span fills the plot's width, and the bins past
 * it stand beyond its edges, in a scroller that first shows the span.
 */

import { m } from "@paraglide/messages";
import { num, percent, places } from "@renderer/locale";
import { edgeOf } from "@tally";
import type { Level } from "@tally";
import { el } from "@renderer/shell/util";
import type { Axis } from "./axes.ts";
import { COLUMN_PITCH_LEAST, aside, sized, upOf, upward } from "./columns.ts";
import type { PlotRoom } from "./kind.ts";
import { BARS_INSET } from "./rows.ts";
import { TICK_GAP } from "./scatter.ts";
import { among } from "./tooltip.ts";
import type { Reading, Targets } from "./tooltip.ts";

/** The level a plot draws, and whether each bin of its span has COLUMN_PITCH_LEAST px. */
export interface Binned {
  level: Level;
  fits: boolean;
}

/** The steps between labelled edges, times a power of ten, so every label is round. */
const EVERY = [1, 2, 5] as const;
const DIGITS = 10;
/** How near its end a scroller counts as there, in px: a zoom leaves scrollLeft fractional. */
const END_SLACK = 1;

/** edgeWords gives the edge of `level`'s bin at `i`, written to the decimals of its width. */
export function edgeWords(level: Level, i: number): string {
  return places(edgeOf(level, i), -level.power);
}

/** across gives the px `room` leaves the bins beside the y axis `up`'s labels. */
function across(up: Axis, room: PlotRoom): number {
  return room.width - 2 * BARS_INSET - aside(up, room);
}

/**
 * edges labels every edge of `level` that is a whole number of the least
 * round step whose labels stand TICK_GAP apart at its bins' pitch in `room`.
 */
function edges(level: Level, up: Axis, room: PlotRoom): HTMLElement {
  const ticks = el("div", "chart-ticks x");
  const words = (i: number) => edgeWords(level, i);
  const count = level.rows.length;
  const widest = Math.max(words(0).length, words(count).length) * room.ch + TICK_GAP;
  const pitch = across(up, room) / level.spans;
  let every = 1;
  for (let ten = 1; every * pitch < widest; ten *= DIGITS) {
    every = (EVERY.find((d) => d * ten * pitch >= widest) ?? DIGITS) * ten;
  }
  for (let i = 0; i <= count; i++) {
    if ((level.first + i) % every !== 0) continue;
    const tick = el("span", "chart-tick", words(i));
    tick.style.setProperty("--at", `${i / count}`);
    tick.style.setProperty("--wide", `${words(i).length}ch`);
    ticks.append(tick);
  }
  return ticks;
}

/** binnedIn gives the finest of `levels` whose span's bins each get COLUMN_PITCH_LEAST px of `room`, or else the coarsest. */
export function binnedIn(levels: readonly Level[], room: PlotRoom): Binned | undefined {
  const fits = (level: Level): boolean =>
    level.spans * COLUMN_PITCH_LEAST <= across(upOf(level.rows), room);
  const level = levels.find(fits) ?? levels.at(-1);
  return level === undefined ? undefined : { level, fits: fits(level) };
}

/**
 * histogram draws `level` as a column of rows per bin, from zero. The bins are
 * as much wider than their scroller as they are more than the span's, and
 * --span-at says where the span starts, in scroller widths, for fitHistogram.
 */
export function histogram({ level, fits }: Binned, room: PlotRoom): HTMLElement {
  const box = el("div", "chart-histogram");
  const up = upOf(level.rows);
  const { span, grid, labels } = upward(up);
  const bins = el("div", "chart-bins");
  bins.style.width = `${(level.rows.length / level.spans) * 100}%`;
  const periods = el("div", "chart-periods");
  periods.append(grid);
  for (const rows of level.rows) {
    const slot = el("div", "chart-period");
    slot.style.setProperty("--share", `${rows / span}`);
    slot.append(el("div", "chart-column"));
    periods.append(slot);
  }
  const along = el("div", "chart-along chart-scrolls themed-bar");
  bins.append(periods, edges(level, up, room));
  along.append(bins);
  sized(box, up, fits);
  box.style.setProperty("--span-at", `${level.at / level.spans}`);
  box.append(labels, along);
  return box;
}

/** fitHistogram scrolls a drawn histogram to its span, and ends its y axis where its bins do, over the bar. */
export function fitHistogram(drawn: HTMLElement): void {
  const along = drawn.querySelector<HTMLElement>(".chart-along");
  const periods = along?.querySelector(".chart-periods");
  if (!along || !periods) return;
  const at = Number(drawn.style.getPropertyValue("--span-at"));
  along.scrollLeft = at * along.clientWidth;
  // Each side with bins past it fades, so a bin or a label cut there reads as more to come.
  const ends = () => {
    const most = along.scrollWidth - along.clientWidth - END_SLACK;
    along.classList.toggle("more-before", along.scrollLeft > END_SLACK);
    along.classList.toggle("more-after", along.scrollLeft < most);
  };
  ends();
  along.addEventListener("scroll", ends);
  const below = along.getBoundingClientRect().bottom - periods.getBoundingClientRect().bottom;
  drawn.style.setProperty("--below", `${below}px`);
}

/** revealed scrolls `slot`'s scroller the least that brings it into sight. */
export function revealed(slot: Element): void {
  const along = slot.closest(".chart-along");
  if (along === null) return;
  const [at, sight] = [slot.getBoundingClientRect(), along.getBoundingClientRect()];
  if (at.left < sight.left) along.scrollLeft -= sight.left - at.left;
  else if (at.right > sight.right) along.scrollLeft += at.right - sight.right;
}

/**
 * binTargets gives the bins of `box`, as histogram drew `level`, in order, the
 * bins past the span too: each worth its rows and their share of `numbers`,
 * named by its edges, written to the decimals of its width. The keys scroll
 * the one they step to into sight.
 */
export function binTargets(level: Level, numbers: number, box: HTMLElement): Targets {
  const edge = (i: number) => edgeWords(level, i);
  const slots = [...box.querySelectorAll(".chart-period")];
  const all = slots.map((slot, i) => {
    const said = (): Reading[] => [
      {
        value: num(level.rows[i]!),
        label: el("span", "", m.chart_bin({ from: edge(i), to: edge(i + 1) })),
      },
      { value: percent(level.rows[i]! / numbers), label: el("span", "", m.chart_table_share()) },
    ];
    const at = slot.firstElementChild!;
    return {
      mark: slot,
      at,
      front: false,
      key: "var(--accent)",
      said,
      reveal: () => revealed(slot),
    };
  });
  return { all, under: among(all, ".chart-period") };
}
