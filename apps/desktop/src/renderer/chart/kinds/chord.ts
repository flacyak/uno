/** @fileoverview A chord chart's kind: the flows between its nodes, and Other, as a ring. */

import type { ChordPlot } from "@document";
import { arcs, chord as drawChord, fitRing } from "../chord.ts";
import type { ChartKind } from "../kind.ts";
import { fitLabels } from "../pie.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** chord is what a window does with a chord chart's plot, titled by its from column until it draws. */
export const chord: ChartKind<ChordPlot> = (plot) => ({
  title: () => named(plot.from),
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
        },
});
