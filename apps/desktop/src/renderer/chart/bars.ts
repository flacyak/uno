/**
 * @fileoverview A bar chart: a bar per value, the largest first, each from zero
 * to its value, with the value at its tip, as many as its plot holds. A line
 * under them counts the rest.
 *
 * The bars are HTML that chart.css lays out by the sizes here, so a theme
 * recolours them and a zoom keeps them crisp: a row per value, its label then
 * its bar on a track. A label is the file's text, set as text alone. The
 * values are mono, so the room they take is their length in ch, and a plot
 * too narrow for them beside its bars draws the bars alone.
 */

import type { Plot } from "@document";
import { DISTINCT_AT_MOST } from "@engine";
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

/**
 * The least of a track the bars keep beside their values, in px: twice a bar's
 * thickness, so the longest bar reads as a length.
 */
export const SPAN_LEAST = 2 * BAR_THICK;

/** What a bar chart draws. */
type Bars = Extract<Plot, { t: "bars" }>;

/** rowsIn gives how many rows of bars or words a plot `height` px high holds. */
function rowsIn(height: number): number {
  return Math.max(Math.floor((height - 2 * BARS_INSET + BAR_GAP) / (BAR_THICK + BAR_GAP)), 0);
}

/** line gives a line of `words` under the bars, whole in its title, as a narrow plot cuts it. */
function line(words: string): HTMLElement {
  const said = el("div", "chart-bars-line", words);
  said.title = words;
  return said;
}

/**
 * room gives what the values on one side of zero take, as CSS: the longest one's
 * characters and the gap before it, or nothing for a side with none.
 */
function room(side: ReadonlyArray<{ tip: string }>): string {
  const widest = Math.max(0, ...side.map(({ tip }) => tip.length));
  return widest === 0 ? "0px" : `calc(${widest}ch + var(--tip-gap))`;
}

/**
 * named gives a bar's label: its value, the file's text, or the app's word for
 * the rows whose cell is blank, which a tally counts as a value of their own.
 */
function named(value: string): HTMLElement {
  if (value === "") return el("span", "chart-bar-label", m.chart_blank_value());
  return el("bdi", "chart-bar-label from-file", value);
}

/**
 * bars draws `groups` as rows or sums per value, as `plot` measures them, in a
 * plot `height` px high. A line of what is left out takes a bar's row.
 */
export function bars(plot: Bars, groups: Groups, height: number): HTMLElement {
  const measure = (g: Group): number => (plot.sum === undefined ? g.rows : g.sum);
  const { others, below, rest } = groups;
  // The rest holds the rows of values past those a tally keeps apart, which it
  // cannot count, so a line of its own says there are more.
  const past = rest.rows > 0;
  const unsent = others.values + below.values > 0 || past;
  const rows = rowsIn(height) - (past ? 1 : 0);
  const all = groups.groups;
  const fit = all.length + (unsent ? 1 : 0) <= rows ? all.length : Math.max(rows - 1, 0);
  const drawn = all.slice(0, fit).map((g) => ({
    label: g.value,
    size: measure(g),
    tip: num(measure(g)),
  }));
  // Every bar starts at zero, on one scale from the least sum to the largest.
  const low = Math.min(0, ...drawn.map(({ size }) => size));
  const span = Math.max(0, ...drawn.map(({ size }) => size)) - low;

  const box = el("div", "chart-bars");
  box.style.setProperty("--bar-thick", `${BAR_THICK}px`);
  box.style.setProperty("--bar-gap", `${BAR_GAP}px`);
  box.style.setProperty("--bars-inset", `${BARS_INSET}px`);
  box.style.setProperty("--tip-gap", `${TIP_GAP}px`);
  box.style.setProperty("--zero", `${span === 0 ? 0 : -low / span}`);
  box.style.setProperty("--room-above", room(drawn.filter(({ size }) => size >= 0)));
  box.style.setProperty("--room-below", room(drawn.filter(({ size }) => size < 0)));
  for (const { label, size, tip } of drawn) {
    const track = el("div", "chart-bar-track");
    track.classList.toggle("below", size < 0);
    track.style.setProperty("--share", `${span === 0 ? 0 : Math.abs(size) / span}`);
    track.append(el("div", "chart-bar"), el("span", "chart-bar-tip", tip));
    const row = el("div", "chart-bar-row");
    row.append(named(label), track);
    box.append(row);
  }

  const left = all.slice(fit);
  if (left.length > 0 || unsent) {
    const values = left.length + others.values + below.values;
    const rowsLeft = left.reduce((sum, g) => sum + g.rows, others.rows + below.rows + rest.rows);
    const more = m.chart_bars_more({ count: num(values) });
    box.append(line(`${more} · ${m.rows_count({ count: rowsLeft })}`));
  }
  if (past) box.append(line(m.chart_bars_past({ count: num(DISTINCT_AT_MOST) })));
  return box;
}

/**
 * fitTips takes the values out of `box`, as bars drew it, where they would leave
 * its bars under SPAN_LEAST px of their track, so the bars take the whole track.
 * The dataviz skill leaves a value with no room past its bar to the tooltip and
 * the table. It measures the drawn values, so `box` stands in the page by then.
 */
export function fitTips(box: HTMLElement): void {
  const track = box.querySelector(".chart-bar-track")?.getBoundingClientRect().width ?? 0;
  // What the values on one side of zero take: the widest, and the gap before it.
  const taken = (side: string): number => {
    const tips = [...box.querySelectorAll(`.chart-bar-track${side} .chart-bar-tip`)];
    const widest = Math.max(0, ...tips.map((tip) => tip.getBoundingClientRect().width));
    return tips.length === 0 ? 0 : widest + TIP_GAP;
  };
  // A plot not laid out yet has nothing to measure, and draws again as it takes a size.
  if (track === 0 || track - taken(".below") - taken(":not(.below)") >= SPAN_LEAST) return;
  for (const tip of box.querySelectorAll(".chart-bar-tip")) tip.remove();
  for (const side of ["--room-above", "--room-below"]) box.style.setProperty(side, "0px");
}
