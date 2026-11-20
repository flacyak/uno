/**
 * @fileoverview A box plot's rows: a box per value, as R's boxplot draws it, a
 * median across it and whiskers with caps, on one axis; a mark past it stands at its edge.
 */

import type { BoxTally } from "@engine";
import type { Box, Within } from "@tally";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { axis, tickLabels } from "./axes.ts";
import { barsBox } from "./bars.ts";
import { row, rowsIn } from "./rows.ts";

/** A row a box plot draws: what it names, and its box. */
export interface Boxed {
  label: string;
  box: Box;
}

/**
 * boxedRows gives the rows of `tally` with a box, in the order it sends them:
 * each value's, the highest median first, then Other's, or, with no values,
 * its column's one box, named `whole`. A value with no number has none.
 */
export function boxedRows(tally: BoxTally, whole: string): Boxed[] {
  const values = tally.values.flatMap(({ value, spread }) =>
    spread.box === undefined ? [] : [{ label: value, box: spread.box }],
  );
  const rest = tally.rest?.box;
  if (rest === undefined) return values;
  return [...values, { label: values.length === 0 ? whole : m.chart_pie_other(), box: rest }];
}

/** middle is where a number a spread knows to its bucket stands: exact, or its bucket's middle. */
const middle = ([low, high]: Within): number => (low + high) / 2;

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
  const up = axis(Math.min(...ends), Math.max(...ends));
  const [low, high] = [up.ticks[0]!, up.ticks.at(-1)!];
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
  return plot;
}
