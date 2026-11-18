/**
 * @fileoverview A pie's kind: each value's share of the rows, or of the sum
 * of another column, as a slice of a ring.
 */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import type { ChartKind } from "../kind.ts";
import { belowZero, fitGaps, fitLabels, past, pie as drawPie } from "../pie.ts";
import { valued } from "../summary.ts";
import { grouped, tableOf } from "../table.ts";
import { sliceTargets } from "../tooltip.ts";
import { named } from "./bars.ts";

/** pie is what a window does with a pie's plot. */
export const pie: ChartKind<Extract<Plot, { t: "pie" }>> = (plot) => ({
  title: () =>
    plot.sum === undefined
      ? m.chart_title_share_of_rows({ by: named(plot.by) })
      : m.chart_title_share_of_sum({ by: named(plot.by), sum: named(plot.sum) }),
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.by],
  drawing: (tally) =>
    tally.t !== "groups"
      ? undefined
      : {
          empty: tally.groups.length === 0,
          draw: () => drawPie(plot, tally),
          fit: (drawn) => {
            fitLabels(drawn);
            fitGaps(drawn);
          },
          targets: (drawn) => sliceTargets(plot, tally, drawn),
          table: (called) => tableOf(grouped(plot, tally), called),
          told: () => valued(plot, tally),
          notes: () => [past(plot, tally), belowZero(plot, tally)],
        },
});
