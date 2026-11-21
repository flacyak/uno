/**
 * @fileoverview A chord chart: the flows between a tally's nodes, and Other,
 * as a ring of arcs. Each arc runs clockwise from the top in slot order, Other
 * last, as long as its node's share of every flow out and in, and wears the
 * slot's colour, Other the caption's ink. A flow at or below zero has no
 * width to draw.
 */

import type { ChordPlot } from "@document";
import type { ChordTally } from "@engine";
import type { Measured } from "@tally";
import { OTHER_KEY } from "./pie.ts";

/** One node's arc: where it starts and ends, turns clockwise from the top, and its colour. */
export interface Arc {
  /** Its place in the tally's flows, Other's after the nodes'. */
  place: number;
  from: number;
  to: number;
  key: string;
}

/** sizeOf gives what a flow draws as in `plot`: its rows or its sum, and nothing at or below zero. */
function sizeOf(plot: ChordPlot): (flow: Measured) => number {
  return ({ rows, sum }) => {
    const size = plot.sum === undefined ? rows : sum;
    return size > 0 ? size : 0;
  };
}

/** keyOf gives the colour of `place` among `nodes`: its slot's, or Other's. */
export function keyOf(place: number, nodes: number): string {
  return place < nodes ? `var(--chart-${place + 1})` : OTHER_KEY;
}

/**
 * arcs gives the ring's arcs of `tally`, each as long as its node's flows out
 * and in, a flow to itself both, all of them making the whole ring. A node of
 * no flow draws no arc.
 */
export function arcs(plot: ChordPlot, tally: ChordTally): Arc[] {
  const size = sizeOf(plot);
  const sizes = tally.flows.map((out, p) =>
    out.reduce((n, flow, q) => n + size(flow) + size(tally.flows[q]![p]!), 0),
  );
  const whole = sizes.reduce((n, s) => n + s, 0);
  if (whole === 0 || !Number.isFinite(whole)) return [];
  let reached = 0;
  return sizes.flatMap((s, place) => {
    const from = reached / whole;
    reached += s;
    if (s === 0) return [];
    return [{ place, from, to: reached / whole, key: keyOf(place, tally.nodes.length) }];
  });
}
