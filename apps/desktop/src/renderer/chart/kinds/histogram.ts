/** @fileoverview A histogram's kind, whose window says it is not drawn yet. */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** histogram is what a window does with a histogram's plot. */
export const histogram: ChartKind<Extract<Plot, { t: "histogram" }>> = (plot) => ({
  title: () => m.chart_title_rows({ by: named(plot.of) }),
  numbered: [plot.of],
  valued: [plot.of],
  drawing: () => undrawn,
});
