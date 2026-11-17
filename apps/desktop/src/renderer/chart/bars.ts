/**
 * @fileoverview A bar chart: a bar per value, the largest first, each from zero
 * to its value, with the value at its tip, as many as its plot holds. A line
 * under them counts the rest.
 *
 * The bars are HTML that chart.css lays out by the sizes here, so a theme
 * recolours them and a zoom keeps them crisp: ranked rows from rows.ts, each
 * a bar on a track beside its label. The values are mono, so the room they
 * take is their length in ch, and a plot too narrow for them beside its bars
 * draws the bars alone.
 */

import type { Plot } from "@document";
import type { Group, Groups } from "@engine";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { BARS_INSET, BAR_GAP, BAR_THICK, ranked, row } from "./rows.ts";

/** The space between a bar's end and its value, in px. */
export const TIP_GAP = 6;

/**
 * The least of a track the bars keep beside their values, in px: twice a bar's
 * thickness, so the longest bar reads as a length.
 */
export const SPAN_LEAST = 2 * BAR_THICK;

/**
 * The length an infinite sum takes where no finite sum has one: any will do, as
 * a bar draws its share of the span.
 */
const ANY_LENGTH = 1;

/** What a bar chart draws. */
type Bars = Extract<Plot, { t: "bars" }>;

/**
 * room gives what the values on one side of zero take, as CSS: the longest one's
 * characters and the gap before it, or nothing for a side with none.
 */
function room(side: ReadonlyArray<{ tip: string }>): string {
  const widest = Math.max(0, ...side.map(({ tip }) => tip.length));
  return widest === 0 ? "0px" : `calc(${widest}ch + var(--tip-gap))`;
}

/**
 * bars draws `groups` as rows or sums per value, as `plot` measures them, in a
 * plot `height` px high. A line of what is left out takes a bar's row.
 */
export function bars(plot: Bars, groups: Groups, height: number): HTMLElement {
  const measure = (g: Group): number => (plot.sum === undefined ? g.rows : g.sum);
  const { shown, lines } = ranked(groups, height);
  const drawn = shown.map((g) => ({
    label: g.value,
    size: measure(g),
    tip: num(measure(g)),
  }));
  // Every bar starts at zero, on one scale from the least length to the largest.
  const lengths = lengthsOf(drawn.map(({ size }) => size));
  const low = Math.min(0, ...lengths);
  const span = Math.max(0, ...lengths) - low;

  const box = el("div", "chart-bars");
  box.style.setProperty("--bar-thick", `${BAR_THICK}px`);
  box.style.setProperty("--bar-gap", `${BAR_GAP}px`);
  box.style.setProperty("--bars-inset", `${BARS_INSET}px`);
  box.style.setProperty("--tip-gap", `${TIP_GAP}px`);
  box.style.setProperty("--zero", `${span === 0 ? 0 : -low / span}`);
  box.style.setProperty("--room-above", room(drawn.filter(({ size }) => size >= 0)));
  box.style.setProperty("--room-below", room(drawn.filter(({ size }) => size < 0)));
  for (const [i, { label, size, tip }] of drawn.entries()) {
    const track = el("div", "chart-bar-track");
    track.classList.toggle("below", size < 0);
    track.style.setProperty("--share", `${span === 0 ? 0 : Math.abs(lengths[i]!) / span}`);
    track.append(el("div", "chart-bar"), el("span", "chart-bar-tip", tip));
    box.append(row(label, track));
  }
  box.append(...lines);
  return box;
}

/**
 * lengthsOf gives how long each of `sizes` draws from zero. A sum past the
 * largest double reads as infinite, and draws as long as the longest finite
 * size on its own side, so the scale stays the finite sizes'. Where its side
 * has none it takes the other side's longest, and any length where no size is
 * finite.
 */
export function lengthsOf(sizes: readonly number[]): number[] {
  const finite = sizes.filter(Number.isFinite);
  return sizes.map((size) => {
    if (Number.isFinite(size)) return size;
    const own = longest(finite.filter((other) => Math.sign(other) === Math.sign(size)));
    const reach = own > 0 ? own : longest(finite);
    return Math.sign(size) * (reach > 0 ? reach : ANY_LENGTH);
  });
}

/** The longest of `sizes` from zero, or 0 where there are none. */
function longest(sizes: number[]): number {
  return Math.max(0, ...sizes.map((size) => Math.abs(size)));
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
