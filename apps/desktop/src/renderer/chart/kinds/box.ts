/** @fileoverview A box plot's kind, whose window says it is not drawn yet. */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** box is what a window does with a box plot's plot: "amount", or "amount per region". */
export const box: ChartKind<Extract<Plot, { t: "box" }>> = (plot) => ({
  title: () =>
    plot.by === undefined
      ? named(plot.of)
      : m.chart_title_per({ of: named(plot.of), by: named(plot.by) }),
  numbered: [plot.of],
  valued: plot.by === undefined ? [plot.of] : [plot.by],
  drawing: () => undrawn,
});
