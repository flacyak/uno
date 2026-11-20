/** @fileoverview A box plot's kind: a box of a number column, or one per value of another. */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import { boxTargets, boxedOver, boxedRows, boxes, fitBoxes } from "../box.ts";
import { boxed, tableOf } from "../table.ts";
import { num } from "@renderer/locale";
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
  drawing: (tally) => {
    if (tally.t !== "box") return undefined;
    const rows = boxedRows(tally, named(plot.of));
    if (rows.length === 0) return { ...undrawn, empty: true };
    const draw = (height: number) => boxes(rows, plot.span === "all", height);
    const figures = rows.flatMap(({ figures: f }) => (f === "exact" ? [] : [f]));
    return {
      ...undrawn,
      draw,
      fit: fitBoxes,
      targets: (drawn) => boxTargets(rows, drawn),
      table: (called) => tableOf(boxed(rows, plot.by ?? plot.of, tally), called),
      told: () => ({ span: boxedOver(rows), each: [], more: 0 }),
      notes: () =>
        figures.length === 0 ? [] : [m.chart_figures({ count: num(Math.min(...figures)) })],
    };
  },
});
