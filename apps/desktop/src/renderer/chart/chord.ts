/**
 * @fileoverview A chord chart: the flows between a tally's nodes, and Other,
 * as a ring of arcs. Each arc runs clockwise from the top in slot order, Other
 * last, as long as its node's share of every flow out and in, and wears the
 * slot's colour, Other the caption's ink. A flow at or below zero has no
 * width to draw. Its sizes are px, so the ring is drawn once it stands in the
 * page and its size is known.
 */

import type { ChordPlot } from "@document";
import type { ChordTally } from "@engine";
import type { Measured } from "@tally";
import { el } from "@renderer/shell/util";
import { LABEL_GAP, OTHER_KEY } from "./pie.ts";
import { BARS_INSET } from "./rows.ts";
import { mark } from "./scatter.ts";

/** How thick an arc is, in px: the legend's key, which wears the same colour. */
export const ARC_WIDTH = 10;

/** The line of the page's ground between two arcs, in px: the marks' surface gap. */
export const ARC_GAP = 2;

/** The least arc that keeps its gaps, in px round the rim: a gap's width of its own colour beside them. */
export const ARC_LEAST = 2 * ARC_GAP;

/** How finely a path is written: to a hundredth of a px. */
const PX_SCALE = 100;

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

/**
 * chord draws `tally`'s ring as `plot` measures it, its arcs still to place
 * by fitRing. A chord of no flow draws nothing.
 */
export function chord(plot: ChordPlot, tally: ChordTally): HTMLElement {
  const box = el("div", "chart-pie chart-chord");
  // It stands as a pie's ring does.
  const ring = mark("svg", "chart-slices chart-chord-ring");
  ring.setAttribute("aria-hidden", "true");
  for (const { from, to, key } of arcs(plot, tally)) {
    const arc = mark("path", "chart-chord-arc");
    arc.style.setProperty("--key", key);
    Object.assign(arc.dataset, { from: `${from}`, to: `${to}` });
    ring.append(arc);
  }
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--label-gap", `${LABEL_GAP}px`);
  const disc = el("div", "chart-pie-disc");
  disc.append(ring);
  box.append(disc);
  return box;
}

/** at writes `n` px as a path holds it, to PX_SCALE. */
function at(n: number): string {
  return `${Math.round(n * PX_SCALE) / PX_SCALE}`;
}

/** onRing gives where `turn` of the way round from the top, clockwise, stands at `radius`. */
function onRing(turn: number, radius: number): string {
  const angle = 2 * Math.PI * turn;
  return `${at(radius * Math.sin(angle))} ${at(-radius * Math.cos(angle))}`;
}

/** band gives the path of the ring's band from `from` to `to` of the way round, `outer` px out. */
function band(from: number, to: number, outer: number): string {
  const inner = outer - ARC_WIDTH;
  // A whole ring is two circles, which no one arc draws.
  if (to - from === 1) return `${circle(outer)}${circle(inner)}`;
  const long = to - from > 1 / 2 ? 1 : 0;
  const arc = (r: number, turn: number, sweep: number) =>
    `A${at(r)} ${at(r)} 0 ${long} ${sweep} ${onRing(turn, r)}`;
  return `M${onRing(from, outer)}${arc(outer, to, 1)}L${onRing(to, inner)}${arc(inner, from, 0)}Z`;
}

/** circle gives the path of a whole circle `r` px out, as two halves. */
function circle(r: number): string {
  const [top, foot] = [at(-r), at(r)];
  return `M0 ${top}A${foot} ${foot} 0 1 1 0 ${foot}A${foot} ${foot} 0 1 1 0 ${top}Z`;
}

/**
 * fitRing places the arcs of `box`, as chord drew it, at the size its ring
 * stands at, each ARC_WIDTH thick at the rim and ARC_GAP from the next,
 * where it is long enough to keep its colour beside the gap.
 */
export function fitRing(box: HTMLElement): void {
  const ring = box.querySelector(".chart-chord-ring");
  const across = ring?.getBoundingClientRect().width ?? 0;
  // A ring not laid out yet has nothing to measure, and draws again as it takes a size.
  if (ring === null || across === 0) return;
  const outer = across / 2;
  const rim = 2 * Math.PI * outer;
  ring.setAttribute("viewBox", `${at(-outer)} ${at(-outer)} ${at(across)} ${at(across)}`);
  // Each end gives half a gap, so two arcs stand a whole one apart.
  const trim = ARC_GAP / 2 / rim;
  for (const arc of ring.querySelectorAll<SVGElement>(".chart-chord-arc")) {
    const [from, to] = [Number(arc.dataset["from"]), Number(arc.dataset["to"])];
    const kept = to - from < 1 && (to - from) * rim >= ARC_LEAST;
    arc.setAttribute("d", kept ? band(from + trim, to - trim, outer) : band(from, to, outer));
  }
}
