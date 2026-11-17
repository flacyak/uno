/**
 * @fileoverview An over-time chart's kind: rows, or the sum of another column,
 * per period of a date column, as columns at the finest size its plot holds,
 * its table and summary of the same periods. A tally with no date has none.
 */

import type { TimePlot } from "@document";
import { m } from "@paraglide/messages";
import { columns, fitted } from "../columns.ts";
import { PER_WORDS } from "../periods.ts";
import type { Fitted } from "../columns.ts";
import type { ChartKind } from "../kind.ts";
import { spannedOver } from "../summary.ts";
import { tableOf, timed } from "../table.ts";
import { periodTargets } from "../tooltip.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

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

/**
 * narrowed gives what the caption says of a plot that draws `drawn` for
 * `plot`: that it is too narrow for a column per period of any size sent,
 * that it draws coarser than the plot's size for want of room, or nothing.
 */
function narrowed({ per }: TimePlot, drawn: Fitted): string {
  const at = PER_WORDS[drawn.level.per]();
  if (!drawn.fits) return m.chart_time_crowded({ per: at });
  if (per === "auto" || per === drawn.level.per) return "";
  return m.chart_time_coarser({ drawn: at, per: PER_WORDS[per]() });
}

/** time is what a window does with an over-time chart's plot. */
export const time: ChartKind<TimePlot> = (plot) => ({
  title: () => title(plot),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.at],
  dated: { at: plot.at, reading: "order" in plot ? plot.order : plot.unit },
  drawing: (tally, room) => {
    if (tally.t !== "time") return undefined;
    const summed = plot.sum !== undefined;
    const drawn = fitted(tally.levels, summed, room);
    if (drawn === undefined) return { ...undrawn, empty: true };
    const { per, span, rows } = drawn.level;
    return {
      empty: false,
      fit: () => undefined,
      draw: () => columns(drawn, summed, room),
      targets: (box) => periodTargets(drawn.level, summed, box),
      table: (called) => tableOf(timed(plot, tally, drawn.level), called),
      told: () => spannedOver(plot, drawn.level),
      notes: () => [narrowed(plot, drawn)],
      wanted: () => (rows.length < span ? [{ per, offset: rows.length }] : []),
    };
  },
});
