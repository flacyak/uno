/** @fileoverview A chord chart's kind: the flows between its nodes, and Other, as a ring. */

import type { ChordPlot } from "@document";
import { m } from "@paraglide/messages";
import { arcs, chord as drawChord, chordTargets, fitRing } from "../chord.ts";
import type { ChartKind } from "../kind.ts";
import { fitLabels } from "../pie.ts";
import { flowed } from "../summary.ts";
import { squared, tableOf } from "../table.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** chord is what a window does with a chord chart's plot, titled by what flows from its from column to its to column. */
export const chord: ChartKind<ChordPlot> = (plot) => ({
  title: () => {
    const [from, to] = [named(plot.from), named(plot.to)];
    return plot.sum === undefined
      ? m.chart_title_chord_rows({ from, to })
      : m.chart_title_chord_sum({ from, to, sum: named(plot.sum) });
  },
  numbered: plot.sum === undefined ? [] : [plot.sum],
  valued: [plot.from, plot.to],
  drawing: (tally) =>
    tally.t !== "chord"
      ? undefined
      : {
          ...undrawn,
          empty: arcs(plot, tally).length === 0,
          draw: () => drawChord(plot, tally),
          // The names may list beside the ring, which takes a size it measures.
          fit: (drawn) => {
            fitLabels(drawn);
            fitRing(drawn);
          },
          targets: (drawn) => chordTargets(plot, tally, drawn),
          table: (called) => tableOf(squared(plot, tally), called),
          told: () => flowed(plot, tally),
        },
});
