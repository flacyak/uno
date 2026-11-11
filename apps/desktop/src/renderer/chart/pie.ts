/**
 * @fileoverview A pie chart: each value's share of the rows, or of a sum. The
 * six largest values above zero have a slice each, and one Other after them
 * holds the rest. A value at or below zero has no share to draw. The caption
 * says how Other takes the values past those a tally keeps apart, and counts
 * the values at or below zero the pie leaves out.
 *
 * The slices go round from the top, as SVG on a ring of radius 1, so whatever
 * sizes the SVG sizes the pie, round in any shape. Each wears its colour as
 * --key, which chart.css fills it with, so a theme recolours it, and a line of
 * the page's ground parts it from the next, where both are wide enough to show
 * beside it. Its label, HTML outside the ring, gives its value, the file's text
 * set as text alone, and its share.
 * Where labels would meet or run past the plot, a list beside the ring gives them.
 */

import type { Plot } from "@document";
import { DISTINCT_AT_MOST } from "@engine";
import type { Groups } from "@engine";
import { m } from "@paraglide/messages";
import { num, percent } from "@renderer/locale";
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

/** measureOf gives what a group measures in `plot`: its rows, or the sum of its cells. */
function measureOf(plot: Pie): (g: { rows: number; sum: number }) => number {
  return (g) => (plot.sum === undefined ? g.rows : g.sum);
}

/**
 * slices gives `groups` as a pie draws them, each as `plot` measures it: the
 * PIE_SLICES_AT_MOST largest sent groups above zero, then Other, which adds the
 * rest above zero and the values past those a tally keeps apart. A pie of fewer
 * has no Other, as the chart colours hold Other apart from the sixth alone.
 */
export function slices(plot: Pie, groups: Groups): Slice[] {
  const measure = measureOf(plot);
  const above = groups.groups.filter((g) => measure(g) > 0);
  const own = above.slice(0, PIE_SLICES_AT_MOST).map((g) => ({ value: g.value, size: measure(g) }));
  if (own.length < PIE_SLICES_AT_MOST) return own;
  const after = above.slice(PIE_SLICES_AT_MOST).reduce((sum, g) => sum + measure(g), 0);
  const other = after + unsent(plot, groups);
  return other > 0 ? [...own, { value: undefined, size: other }] : own;
}

/**
 * unsent gives what Other takes of the values a tally sent none of, as `plot`
 * measures them: those above zero as they are, and the values past those a
 * tally keeps apart, which sum together whatever their sign, only where they
 * come to more than zero.
 */
export function unsent(plot: Pie, groups: Groups): number {
  const measure = measureOf(plot);
  return measure(groups.others) + Math.max(measure(groups.rest), 0);
}

/** wholeOf gives what `drawn` adds up to, or 0 for a whole no double holds, which no share is of. */
export function wholeOf(drawn: readonly Slice[]): number {
  const whole = drawn.reduce((sum, { size }) => sum + size, 0);
  return Number.isFinite(whole) ? whole : 0;
}

/**
 * past gives what a pie's caption says of the values past those a tally keeps
 * apart, or nothing where there are none. Other counts their rows as they are,
 * and takes their sum where it comes to more than zero, though it nets values
 * of either sign, so the caption says so. Where they come to nothing above
 * zero, or the pie draws no Other, it leaves them out, and says that.
 */
export function past(plot: Pie, groups: Groups): string {
  const { rest } = groups;
  if (rest.rows === 0) return "";
  const count = num(DISTINCT_AT_MOST);
  const counted = slices(plot, groups).length > PIE_SLICES_AT_MOST && measureOf(plot)(rest) > 0;
  if (!counted) return m.chart_pie_past_left_out({ count });
  return plot.sum === undefined ? "" : m.chart_pie_past_net({ count });
}

/**
 * belowZero gives what a pie's caption says of the values at or below zero,
 * which have no share to draw: those sent and those not, as `plot` measures
 * them. A value's rows are always above zero, so a share of rows leaves none
 * out, and the caption says nothing.
 */
export function belowZero(plot: Pie, groups: Groups): string {
  const measure = measureOf(plot);
  const sent = groups.groups.filter((g) => measure(g) <= 0).length;
  const count = sent + groups.below.values;
  return count > 0 ? m.chart_pie_below_zero({ count }) : "";
}

/**
 * What Other wears: the caption's ink, which the chart colours stand apart
 * from after the sixth. The six wear --chart-1 to --chart-6, in their order.
 */
const OTHER_KEY = "var(--ink-3)";

/** The room between the ring and a label, in px: as far as a bar's value stands from its bar. */
export const LABEL_GAP = TIP_GAP;

/** The width of the line of the page's ground that parts two slices, in px. */
const SLICE_GAP = 1;

/**
 * The least arc a slice keeps its gaps beside, in px round the rim: half a gap
 * at each end, and a gap's width of its own colour between them.
 */
export const SLICE_LEAST = 2 * SLICE_GAP;

/** How far past its room a label may measure, in px: a layout's rounding, under a px. */
const FIT_SLACK = 0.5;

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

/**
 * gap gives the line that parts two slices where they meet, `turn` of the way
 * round, with the smaller's `share` of the whole, for fitGaps to measure.
 */
function gap(turn: number, share: number): SVGElement {
  const line = mark("path", "chart-slice-gap");
  line.setAttribute("d", `M0 0L${point(turn)}`);
  line.dataset["share"] = `${share}`;
  return line;
}

/**
 * words gives what a slice says: its value, the file's text, or Other, or the
 * app's word for the rows whose cell is blank, and its share.
 */
function words(value: string | undefined, share: number): [HTMLElement, HTMLElement] {
  const name =
    value === undefined
      ? el("span", "chart-slice-name", m.chart_pie_other())
      : value === ""
        ? el("span", "chart-slice-name", m.chart_blank_value())
        : el("bdi", "chart-slice-name from-file", value);
  return [name, el("span", "chart-slice-share", percent(share))];
}

/**
 * label gives the label of a slice of `value`, or Other, `share` of the whole,
 * with where the middle of its arc, `turn` of the way round, stands on the
 * ring as --x and --y, for chart.css to stand it past there on its side.
 */
function label(value: string | undefined, share: number, turn: number): HTMLElement {
  const said = el("div", "chart-slice-label");
  const [name, part] = words(value, share);
  said.append(name, " ", part);
  const [x, y] = onRing(turn);
  said.style.setProperty("--x", at(x));
  said.style.setProperty("--y", at(y));
  return said;
}

/** entry gives a slice's entry in the list: its colour, `key`, then what it says. */
function entry(key: string, value: string | undefined, share: number): HTMLElement {
  const swatch = el("span", "chart-legend-key");
  swatch.style.setProperty("--key", key);
  const item = el("li");
  item.append(swatch, ...words(value, share));
  return item;
}

/**
 * pie draws `groups` as `plot` shares them out, from the top clockwise. A pie
 * of nothing above zero, or of a whole no double holds, has no share to draw,
 * so draws nothing.
 */
export function pie(plot: Pie, groups: Groups): HTMLElement {
  const box = el("div", "chart-pie");
  const drawn = slices(plot, groups);
  const whole = wholeOf(drawn);
  if (whole === 0) return box;
  const ring = mark("svg", "chart-slices");
  ring.setAttribute("viewBox", VIEW);
  ring.setAttribute("aria-hidden", "true");
  // Each slice ends where the sizes so far reach, so the last ends on the whole.
  let reached = 0;
  const gaps: SVGElement[] = [];
  const labels: HTMLElement[] = [];
  const list = el("ul", "chart-legend chart-scrolls themed-bar");
  for (const [i, { value, size }] of drawn.entries()) {
    const from = reached / whole;
    reached += size;
    const to = reached / whole;
    const slice = wedge(from, to);
    const key = value === undefined ? OTHER_KEY : `var(--chart-${i + 1})`;
    slice.style.setProperty("--key", key);
    ring.append(slice);
    // Each slice's gap stands where it starts, after the slice before it, the first's after the last.
    const prior = drawn.at(i - 1)?.size ?? size;
    gaps.push(gap(from, Math.min(size, prior) / whole));
    labels.push(label(value, size / whole, (from + to) / 2));
    list.append(entry(key, value, size / whole));
  }
  if (drawn.length > 1) ring.append(...gaps);
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--label-gap", `${LABEL_GAP}px`);
  box.style.setProperty("--slice-gap", `${SLICE_GAP}px`);
  const disc = el("div", "chart-pie-disc");
  disc.append(ring, ...labels);
  box.append(disc, list);
  return box;
}

/** before says whether `a` stands `gap` px or more before `b`, give or take FIT_SLACK. */
function before(a: number, b: number, gap: number): boolean {
  return a + gap <= b + FIT_SLACK;
}

/**
 * fitLabels marks `box`, as pie drew it, listed where two of its labels stand
 * under LABEL_GAP apart or one runs into the plot's inset. It measures the
 * drawn labels, so `box` stands in the page by then.
 */
export function fitLabels(box: HTMLElement): void {
  const room = box.getBoundingClientRect();
  // A plot not laid out yet has nothing to measure, and draws again as it takes a size.
  if (room.width === 0) return;
  const inside = (rect: DOMRect): boolean =>
    before(room.left, rect.left, BARS_INSET) &&
    before(room.top, rect.top, BARS_INSET) &&
    before(rect.right, room.right, BARS_INSET) &&
    before(rect.bottom, room.bottom, BARS_INSET);
  // Two labels stand apart where one stands LABEL_GAP over the other, or along it.
  const apart = (a: DOMRect, b: DOMRect): boolean =>
    before(a.bottom, b.top, LABEL_GAP) ||
    before(b.bottom, a.top, LABEL_GAP) ||
    before(a.right, b.left, LABEL_GAP) ||
    before(b.right, a.left, LABEL_GAP);
  const drawn = [...box.querySelectorAll(".chart-slice-label")].map((shown) =>
    shown.getBoundingClientRect(),
  );
  const fit = drawn.every((a, i) => inside(a) && drawn.slice(i + 1).every((b) => apart(a, b)));
  box.classList.toggle("listed", !fit);
}

/**
 * fitGaps marks each gap of `box`, as pie drew it, that covers a slice under
 * SLICE_LEAST round the rim, for chart.css to hide, so the slice shows in its
 * colour, which parts it from the next. It measures the drawn ring, so `box`
 * stands in the page by then.
 */
export function fitGaps(box: HTMLElement): void {
  const ring = box.querySelector(".chart-slices")?.getBoundingClientRect();
  // A plot not laid out yet has nothing to measure, and draws again as it takes a size.
  if (ring === undefined || ring.width === 0) return;
  const rim = Math.PI * Math.min(ring.width, ring.height);
  for (const line of box.querySelectorAll<SVGElement>(".chart-slice-gap")) {
    line.classList.toggle("covers", Number(line.dataset["share"]) * rim < SLICE_LEAST);
  }
}
