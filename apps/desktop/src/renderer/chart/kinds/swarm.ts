/** @fileoverview A beeswarm's kind: a dot per sampled row at its number, in a strip per value or one. */

import type { SwarmPlot } from "@document";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import type { ChartKind } from "../kind.ts";
import { packed, swarm as drawSwarm, swarmTargets } from "../swarm.ts";
import type { Packed } from "../swarm.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** swarm is what a window does with a beeswarm's plot: "amount", or "amount per region". */
export const swarm: ChartKind<SwarmPlot> = (plot) => ({
  title: () =>
    plot.by === undefined
      ? named(plot.of)
      : m.chart_title_per({ of: named(plot.of), by: named(plot.by) }),
  numbered: [plot.of],
  valued: plot.by === undefined ? [plot.of] : [plot.by],
  drawing: (tally, room) => {
    if (tally.t !== "swarm") return undefined;
    if (tally.plotted === 0) return { ...undrawn, empty: true };
    const whole = plot.by === undefined ? named(plot.of) : undefined;
    // The caption counts the dots the last drawing drew.
    let drawn: Packed[] = [];
    return {
      ...undrawn,
      draw: (height) => {
        drawn = packed(tally, whole, room, height);
        return drawSwarm(drawn, tally);
      },
      targets: (box) => swarmTargets(drawn, box),
      notes: () => {
        const shown = drawn.reduce((sum, { dots }) => sum + dots.length, 0);
        if (shown >= tally.plotted) return [];
        const rows = m.rows_count({ count: tally.plotted });
        return [m.chart_rows_sampled({ shown: num(shown), rows })];
      },
    };
  },
});
