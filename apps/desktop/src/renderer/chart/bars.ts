/**
 * @fileoverview A bar chart: a bar per value, the largest first, each as long
 * as its share of the largest, with the value at its tip, as many as its plot
 * holds. A line under them counts the rest.
 *
 * The bars are HTML that chart.css lays out by the sizes here, so a theme
 * recolours them and a zoom keeps them crisp. A label is the file's text, set
 * as text alone. The values are mono, so the room they take is their length in
 * ch.
 */

import type { Plot } from "@document";
import type { Group, Groups } from "@engine";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";

/** A bar's thickness, in px: the dataviz skill's most. */
export const BAR_THICK = 24;

/** The window's ground between two bars, in px: the dataviz skill's gap. */
export const BAR_GAP = 2;

/**
 * The space around the rows, in px: as far in as the head's title and the
 * caption's words stand from the window's edge.
 */
export const BARS_INSET = 10;

/** The space between a bar's end and its value, in px. */
export const TIP_GAP = 6;

/** What a bar chart draws. */
type Bars = Extract<Plot, { t: "bars" }>;

/** rowsIn gives how many rows of bars or words a plot `height` px high holds. */
function rowsIn(height: number): number {
  return Math.max(Math.floor((height - 2 * BARS_INSET + BAR_GAP) / (BAR_THICK + BAR_GAP)), 0);
}

/**
 * bars draws `groups` as rows or sums per value, as `plot` measures them, in a
 * plot `height` px high. A line of what is left out takes a bar's row.
 */
export function bars(plot: Bars, groups: Groups, height: number): HTMLElement {
  const measure = (g: Group): number => (plot.sum === undefined ? g.rows : g.sum);
  const { others, below } = groups;
  const unsent = others.values + below.values > 0;
  const rows = rowsIn(height);
  const all = groups.groups;
  const fit = all.length + (unsent ? 1 : 0) <= rows ? all.length : Math.max(rows - 1, 0);
  const drawn = all.slice(0, fit).map((g) => ({
    label: g.value,
    size: measure(g),
    tip: num(measure(g)),
  }));
  const largest = Math.max(0, ...drawn.map(({ size }) => size));
  const widest = Math.max(0, ...drawn.map(({ tip }) => tip.length));

  const box = el("div", "chart-bars");
  box.style.setProperty("--bar-thick", `${BAR_THICK}px`);
  box.style.setProperty("--bar-gap", `${BAR_GAP}px`);
  box.style.setProperty("--bars-inset", `${BARS_INSET}px`);
  box.style.setProperty("--tip-gap", `${TIP_GAP}px`);
  box.style.setProperty("--tip-room", `${widest}ch`);
  for (const { label, size, tip } of drawn) {
    const track = el("div", "chart-bar-track");
    track.style.setProperty("--share", `${largest === 0 ? 0 : size / largest}`);
    track.append(el("div", "chart-bar"), el("span", "chart-bar-tip", tip));
    box.append(el("bdi", "chart-bar-label from-file", label), track);
  }

  const left = all.slice(fit);
  if (left.length > 0 || unsent) {
    const values = left.length + others.values + below.values;
    const rowsLeft = left.reduce((sum, g) => sum + g.rows, others.rows + below.rows);
    const more = m.chart_bars_more({ count: num(values) });
    box.append(el("div", "chart-bars-line", `${more} · ${m.rows_count({ count: rowsLeft })}`));
  }
  return box;
}
