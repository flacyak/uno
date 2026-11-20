/**
 * @fileoverview A box plot's rows: a box per value, as R's boxplot draws it, a
 * median across it and whiskers with caps, on one axis; a mark past it stands at its edge.
 */

import type { BoxTally } from "@engine";

import type { Box, Figures, Within } from "@tally";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { revealed } from "./histogram.ts";
import { among } from "./tooltip.ts";
import type { Reading, Targets } from "./tooltip.ts";
import { el } from "@renderer/shell/util";
import { axis, tickLabels } from "./axes.ts";
import type { Axis } from "./axes.ts";
import { barsBox } from "./bars.ts";
import { row, rowsIn } from "./rows.ts";

/** A spread as a box plot's tally sends it. */
type Spreading = NonNullable<BoxTally["rest"]>;

/** A row a box plot draws: what it names, and its box. */
export interface Boxed {
  label: string;
  box: Box;
  /** The rows whose cells read as numbers, and the figures its spread holds them to. */
  numbers: number;
  figures: Figures;
}

/**
 * boxedRows gives the rows of `tally` with a box, in the order it sends them:
 * each value's, the highest median first, then Other's, or, with no values,
 * its column's one box, named `whole`. A value with no number has none.
 */
export function boxedRows(tally: BoxTally, whole: string): Boxed[] {
  const boxed = (label: string, { box, numbers, figures }: Spreading): Boxed[] =>
    box === undefined ? [] : [{ label, box, numbers, figures }];
  const values = tally.values.flatMap(({ value, spread }) => boxed(value, spread));
  if (tally.rest === undefined) return values;
  return [...values, ...boxed(values.length === 0 ? whole : m.chart_pie_other(), tally.rest)];
}

/** middle is where a number a spread knows to its bucket stands: exact, or its bucket's middle. */
export const middle = ([low, high]: Within): number => (low + high) / 2;

/**
 * The most spans a box plot's axis reaches past its span on each side, so the
 * numbers past it a scroll away stand apart, and one far placeholder cannot
 * make the scroll a mile long; a mark further out stands at its far edge.
 */
const REACH_AT_MOST = 2;

/**
 * reaching gives the axis of `span`, as many more spans of its width to each
 * side as the least and the most of `rows` reach into, up to REACH_AT_MOST,
 * with its ticks a step apart throughout, and how many spans it reaches before.
 */
function reaching(span: Axis, rows: readonly Boxed[]): [Axis, number] {
  const [low, high] = [span.ticks[0]!, span.ticks.at(-1)!];
  const width = high - low;
  const spans = (past: number) => Math.min(Math.max(Math.ceil(past / width), 0), REACH_AT_MOST);
  const before = spans(low - Math.min(...rows.map(({ box }) => box.five[0]![0])));
  const after = spans(Math.max(...rows.map(({ box }) => box.five[4]![1])) - high);
  const parts = Array.from({ length: before + 1 + after }, (_, i) => {
    const by = (i - before) * width;
    return axis(low + by, high + by);
  });
  const ticks = parts.flatMap((part, i) => part.ticks.slice(i === 0 ? 0 : 1));
  const labels = parts.flatMap((part, i) => part.labels.slice(i === 0 ? 0 : 1));
  return [{ ticks, labels, compact: parts.some((part) => part.compact) }, before];
}

/** mark gives a mark of `kind` from `from` to `to` of the axis, as shares of it. */
function mark(kind: string, from: number, to: number): HTMLElement {
  const made = el("div", kind);
  made.style.setProperty("--from", `${from}`);
  made.style.setProperty("--to", `${to}`);
  return made;
}

/**
 * boxes draws `rows` in a plot `height` px high, over the 1st to 99th
 * percentile where `all` is false, or every number, on one axis.
 */
export function boxes(rows: readonly Boxed[], all: boolean, height: number): HTMLElement {
  const ends = rows.flatMap(({ box }) =>
    all ? [box.five[0]![0], box.five[4]![1]] : [box.span[0]![0], box.span[1]![1]],
  );
  const span = axis(Math.min(...ends), Math.max(...ends));
  const [up, before] = all ? [span, 0] : reaching(span, rows);
  const [low, high] = [up.ticks[0]!, up.ticks.at(-1)!];
  const spans = (high - low) / (span.ticks.at(-1)! - span.ticks[0]!);
  const at = (x: number) => Math.min(Math.max((x - low) / (high - low), 0), 1);
  // The axis's labels take a row, and a line of the rows left out another.
  const fits = Math.max(rowsIn(height) - 1, 0);
  const shown = rows.length <= fits ? rows : rows.slice(0, Math.max(fits - 1, 0));
  const plot = barsBox("chart-boxes");
  for (const { label, box } of shown) {
    const [q1, median, q3] = [box.five[1]!, box.five[2]!, box.five[3]!].map(middle);
    const [whiskLow, whiskHigh] = box.whiskers.map(middle);
    const track = el("div", "chart-box-track");
    track.append(
      mark("chart-whisker", at(whiskLow!), at(whiskHigh!)),
      mark("chart-box", at(q1!), at(q3!)),
      mark("chart-median", at(median!), at(median!)),
      ...[...box.below.buckets, ...box.above.buckets].map((b) => {
        const x = at(middle([b.low, b.high]));
        return mark("chart-past", x, x);
      }),
    );
    plot.append(row(label, track));
  }
  const left = rows.length - shown.length;
  if (left > 0) plot.append(el("div", "chart-bars-line", m.chart_bars_more({ count: num(left) })));
  const ticks = el("div", "chart-ticks x");
  for (const [i, label] of tickLabels(up).entries()) {
    label.style.setProperty("--at", `${at(up.ticks[i]!)}`);
    label.style.setProperty("--wide", `${label.textContent!.length}ch`);
    ticks.append(label);
  }
  const under = el("div", "chart-bar-row chart-box-axis");
  under.append(el("span"), ticks);
  plot.append(under);
  plot.style.setProperty("--spans", `${spans}`);
  plot.style.setProperty("--span-at", `${before}`);
  const along = el("div", "chart-along chart-scrolls themed-bar");
  along.append(plot);
  return along;
}

/**
 * fitBoxes widens a drawn box plot's tracks to as many times the room beside
 * its labels as its axis reaches spans, and scrolls to its span, the labels
 * standing still.
 */
export function fitBoxes(along: HTMLElement): void {
  const plot = along.querySelector<HTMLElement>(".chart-boxes");
  if (plot === null) return;
  const style = getComputedStyle(plot);
  const label = parseFloat(style.gridTemplateColumns);
  const inside = along.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const room = inside - label - parseFloat(style.columnGap);
  const spans = Number(plot.style.getPropertyValue("--spans"));
  plot.style.gridTemplateColumns = `${label}px ${room * spans}px`;
  along.scrollLeft = Number(plot.style.getPropertyValue("--span-at")) * room;
}

/** The keys a box plot's targets step past the tooltip's: to the next row and the one before. */
const ROWS_STEP = ["ArrowDown", "ArrowUp"] as const;

/**
 * boxTargets gives the rows of `drawn`, as boxes drew `rows`: each worth its
 * median, named by its value, its middle half, its whiskers, the rows past
 * them and its mean. Down and Up step the rows as Right and Left do, and the
 * row they step to scrolls its box into sight.
 */
export function boxTargets(rows: readonly Boxed[], drawn: HTMLElement): Targets {
  const tracks = [...drawn.querySelectorAll(".chart-bar-row:has(.chart-box-track)")];
  const all = tracks.map((track, i) => {
    const { label, box } = rows[i]!;
    const words = (text: string) => el("span", "", text);
    const between = (low: Within, high: Within) =>
      m.chart_bin({ from: num(middle(low)), to: num(middle(high)) });
    const said = (): Reading[] => {
      const median = el("span", "", `${m.chart_box_median()} `);
      median.append(el("bdi", "from-file", label));
      return [
        { value: num(middle(box.five[2]!)), label: median },
        { value: between(box.five[1]!, box.five[3]!), label: words(m.chart_box_middle()) },
        {
          value: between(box.whiskers[0]!, box.whiskers[1]!),
          label: words(m.chart_box_whiskers()),
        },
        { value: num(box.below.rows + box.above.rows), label: words(m.chart_box_past()) },
        { value: num(box.mean), label: words(m.chart_box_mean()) },
      ];
    };
    const at = track.querySelector(".chart-box")!;
    return {
      mark: track,
      at,
      front: false,
      key: "var(--accent)",
      said,
      reveal: () => revealed(at),
    };
  });
  const step = (key: string, at: number | undefined): number | undefined => {
    const to =
      key === ROWS_STEP[0]
        ? (at ?? -1) + 1
        : key === ROWS_STEP[1]
          ? (at ?? all.length) - 1
          : undefined;
    return to === undefined ? undefined : Math.min(Math.max(to, 0), all.length - 1);
  };
  return { all, under: among(all, ".chart-bar-row"), step, keys: ROWS_STEP };
}

/** boxedOver gives what a box plot's summary says past its rows: its highest and lowest medians. */
export function boxedOver(rows: readonly Boxed[]): string {
  const median = (at: Boxed) => num(middle(at.box.five[2]!));
  const [top, bottom] = [rows[0]!, rows.at(-1)!];
  if (rows.length === 1) return m.chart_summary_box_one({ median: median(top) });
  // A blank value reads as the app's word for one.
  const name = (at: Boxed) => (at.label === "" ? m.chart_blank_value() : at.label);
  return m.chart_summary_box({
    top: name(top),
    high: median(top),
    bottom: name(bottom),
    low: median(bottom),
  });
}
