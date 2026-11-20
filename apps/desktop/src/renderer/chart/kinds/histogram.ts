/** @fileoverview A histogram's kind: rows per bin of one number column. */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import { binTargets, binnedIn, fitHistogram, histogram as drawn } from "../histogram.ts";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { binned as tabled, tableOf } from "../table.ts";
import { undrawn } from "./undrawn.ts";

/** histogram is what a window does with a histogram's plot. */
export const histogram: ChartKind<Extract<Plot, { t: "histogram" }>> = (plot) => ({
  title: () => m.chart_title_rows({ by: named(plot.of) }),
  numbered: [plot.of],
  valued: [plot.of],
  drawing: (tally, room) => {
    if (tally.t !== "spread") return undefined;
    const binned = binnedIn(tally.levels, room);
    if (binned === undefined) return { ...undrawn, empty: true };
    const { level } = binned;
    return {
      ...undrawn,
      draw: () => drawn(binned, room),
      fit: fitHistogram,
      targets: (drawn) => binTargets(level, tally.numbers, drawn),
      table: (called) => tableOf(tabled(plot.of, tally, level), called),
    };
  },
});
