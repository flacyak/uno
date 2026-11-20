/** @fileoverview A histogram's kind: rows per bin of one number column. */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import { binTargets, binnedIn, fitHistogram, histogram as drawn } from "../histogram.ts";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
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
    return {
      ...undrawn,
      draw: () => drawn(binned),
      fit: fitHistogram,
      targets: (box) => binTargets(binned.level, tally.numbers, box),
    };
  },
});
