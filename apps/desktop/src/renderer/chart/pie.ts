/**
 * @fileoverview A pie chart: each value's share of the rows, or of a sum. The
 * six largest values above zero have a slice each, and one Other after them
 * holds the rest. A value at or below zero has no share to draw.
 *
 * The slices go round from the top, as SVG on a ring of radius 1, so whatever
 * sizes the SVG sizes the pie, round in any shape. Each wears its colour as
 * --key, which chart.css fills it with, so a theme recolours it, and a line of
 * the page's ground parts it from the next. Its label, HTML outside the ring,
 * gives its value, the file's text set as text alone, and its share.
 */

import type { Plot } from "@document";
import type { Groups } from "@engine";
import { m } from "@paraglide/messages";
import { percent } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { BARS_INSET, TIP_GAP } from "./bars.ts";
import { mark } from "./scatter.ts";

/** How many values have a slice of their own: the colours a theme gives a chart. */
export const PIE_SLICES_AT_MOST = 6;

/** What a pie chart draws. */
type Pie = Extract<Plot, { t: "pie" }>;

/** A slice of a pie: the value it stands for, or none for Other, and what it measures. */
export interface Slice {
  value: string | undefined;
  size: number;
}

/**
 * slices gives `groups` as a pie draws them, each as `plot` measures it: the
 * PIE_SLICES_AT_MOST largest sent groups above zero, then Other, which adds the
 * rest above zero and the values past those a tally keeps apart. A pie of fewer
 * has no Other, as the chart colours hold Other apart from the sixth alone.
 */
export function slices(plot: Pie, groups: Groups): Slice[] {
  const measure = (g: { rows: number; sum: number }): number =>
    plot.sum === undefined ? g.rows : g.sum;
  const above = groups.groups.filter((g) => measure(g) > 0);
  const own = above.slice(0, PIE_SLICES_AT_MOST).map((g) => ({ value: g.value, size: measure(g) }));
  if (own.length < PIE_SLICES_AT_MOST) return own;
  const after = above.slice(PIE_SLICES_AT_MOST).reduce((sum, g) => sum + measure(g), 0);
  // The values past those a tally keeps apart sum together whatever their sign,
  // so Other takes them only where they come to more than zero.
  const other = after + measure(groups.others) + Math.max(measure(groups.rest), 0);
  return other > 0 ? [...own, { value: undefined, size: other }] : own;
}

/**
 * What Other wears: the caption's ink, which the chart colours stand apart
 * from after the sixth. The six wear --chart-1 to --chart-6, in their order.
 */
const OTHER_KEY = "var(--ink-3)";

/** The room between the ring and a label, in px: as far as a bar's value stands from its bar. */
export const LABEL_GAP = TIP_GAP;

/** The SVG's view: two across, round its middle, so the ring's radius is 1. */
const VIEW = "-1 -1 2 2";

/** How finely a path is written: to a millionth of the radius, far under a px of any pie. */
const PATH_SCALE = 1e6;

/** at writes `n` as a path holds it, to PATH_SCALE. */
function at(n: number): string {
  return `${Math.round(n * PATH_SCALE) / PATH_SCALE}`;
}

/** onRing gives where `turn` of the way round from the top, clockwise, stands on the ring. */
function onRing(turn: number): [number, number] {
  const angle = 2 * Math.PI * turn;
  return [Math.sin(angle), -Math.cos(angle)];
}

/** point writes where `turn` of the way round stands on the ring, as a path holds it. */
function point(turn: number): string {
  return onRing(turn).map(at).join(" ");
}

/**
 * wedge gives the slice from `from` to `to` of the way round. The whole ring is
 * a circle, as no one arc ends where it starts.
 */
function wedge(from: number, to: number): SVGElement {
  if (from === 0 && to === 1) {
    const all = mark("circle", "chart-slice");
    all.setAttribute("r", "1");
    return all;
  }
  const slice = mark("path", "chart-slice");
  // The arc goes the long way round for a slice of more than half the pie.
  const long = to - from > 1 / 2 ? 1 : 0;
  slice.setAttribute("d", `M0 0L${point(from)}A1 1 0 ${long} 1 ${point(to)}Z`);
  return slice;
}

/** gap gives the line that parts two slices where they meet, `turn` of the way round. */
function gap(turn: number): SVGElement {
  const line = mark("path", "chart-slice-gap");
  line.setAttribute("d", `M0 0L${point(turn)}`);
  return line;
}

/**
 * label gives the label of a slice of `value`, or Other, `share` of the whole,
 * with where the middle of its arc, `turn` of the way round, stands on the
 * ring as --x and --y, for chart.css to stand it past there on its side.
 */
function label(value: string | undefined, share: number, turn: number): HTMLElement {
  const said = el("div", "chart-slice-label");
  const name =
    value === undefined ? el("span", "", m.chart_pie_other()) : el("bdi", "from-file", value);
  said.append(name, " ", el("span", "chart-slice-share", percent(share)));
  const [x, y] = onRing(turn);
  said.style.setProperty("--x", at(x));
  said.style.setProperty("--y", at(y));
  return said;
}

/**
 * pie draws `groups` as `plot` shares them out, from the top clockwise. A pie
 * of nothing above zero, or of a whole no double holds, has no share to draw,
 * so draws nothing.
 */
export function pie(plot: Pie, groups: Groups): HTMLElement {
  const box = el("div", "chart-pie");
  const drawn = slices(plot, groups);
  const whole = drawn.reduce((sum, { size }) => sum + size, 0);
  if (drawn.length === 0 || !Number.isFinite(whole)) return box;
  const ring = mark("svg", "chart-slices");
  ring.setAttribute("viewBox", VIEW);
  ring.setAttribute("aria-hidden", "true");
  // Each slice ends where the sizes so far reach, so the last ends on the whole.
  let reached = 0;
  const gaps: SVGElement[] = [];
  const labels: HTMLElement[] = [];
  for (const [i, { value, size }] of drawn.entries()) {
    const from = reached / whole;
    reached += size;
    const to = reached / whole;
    const slice = wedge(from, to);
    slice.style.setProperty("--key", value === undefined ? OTHER_KEY : `var(--chart-${i + 1})`);
    ring.append(slice);
    gaps.push(gap(from));
    labels.push(label(value, size / whole, (from + to) / 2));
  }
  if (drawn.length > 1) ring.append(...gaps);
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--label-gap", `${LABEL_GAP}px`);
  const disc = el("div", "chart-pie-disc");
  disc.append(ring, ...labels);
  box.append(disc);
  return box;
}
