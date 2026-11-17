/**
 * @fileoverview An over-time chart's kind: rows, or the sum of another column,
 * per period of a date column, as columns at the finest size its plot holds.
 * Its marks, table and summary land later, and its table says so until then.
 */

import type { TimePlot } from "@document";
import { m } from "@paraglide/messages";
import { columns, fitted } from "../columns.ts";
import type { ChartKind } from "../kind.ts";
import { NONE } from "../tooltip.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** The sizes an over-time chart draws per. */
type Per = Exclude<TimePlot["per"], "auto">;

/** What each size is called in a made title, in the app's language. */
export const PER_WORDS: Readonly<Record<Per, () => string>> = {
  hour: m.chart_per_hour,
  day: m.chart_per_day,
  week: m.chart_per_week,
  month: m.chart_per_month,
  quarter: m.chart_per_quarter,
  year: m.chart_per_year,
};

/** title gives the title an over-time plot makes, per its size or over its span. */
function title({ at, sum, per }: TimePlot): string {
  const dates = named(at);
  if (per === "auto") {
    return sum === undefined
      ? m.chart_title_time_rows_over({ at: dates })
      : m.chart_title_time_sum_over({ at: dates, sum: named(sum) });
  }
  const size = PER_WORDS[per]();
  return sum === undefined
    ? m.chart_title_time_rows({ at: dates, per: size })
    : m.chart_title_time_sum({ at: dates, per: size, sum: named(sum) });
}

/** time is what a window does with an over-time chart's plot. */
export const time: ChartKind<TimePlot> = (plot) => ({
  title: () => title(plot),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.at],
  drawing: (tally, room) => {
    if (tally.t !== "time") return undefined;
    const summed = plot.sum !== undefined;
    const drawn = fitted(tally.levels, summed, room);
    if (drawn === undefined) return { ...undrawn, empty: true };
    const { per, span, rows } = drawn.level;
    return {
      ...undrawn,
      draw: () => columns(drawn, summed),
      targets: () => NONE,
      wanted: () => (rows.length < span ? [{ per, offset: rows.length }] : []),
    };
  },
});
