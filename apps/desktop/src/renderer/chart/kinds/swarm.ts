/** @fileoverview A beeswarm's kind, whose window says it is not drawn yet. */

import type { SwarmPlot } from "@document";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** swarm is what a window does with a beeswarm's plot, titled by its numbers until it draws. */
export const swarm: ChartKind<SwarmPlot> = (plot) => ({
  title: () => named(plot.of),
  numbered: [plot.of],
  valued: plot.by === undefined ? [plot.of] : [plot.by],
  drawing: () => undrawn,
});
