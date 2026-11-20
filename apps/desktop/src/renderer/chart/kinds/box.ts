/** @fileoverview A box plot's kind, whose window says it is not drawn yet. */

import type { Plot } from "@document";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** box is what a window does with a box plot's plot, titled by its column. */
export const box: ChartKind<Extract<Plot, { t: "box" }>> = (plot) => ({
  title: () => named(plot.of),
  numbered: [plot.of],
  valued: [plot.of],
  drawing: () => undrawn,
});
