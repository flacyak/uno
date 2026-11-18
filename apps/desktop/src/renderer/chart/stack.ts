/**
 * @fileoverview A stacked bar chart: a bar per value, the largest first, split
 * into a segment per series in the order of their slots, then Other. A value's
 * parts above zero stack rightward from zero and those below leftward, on one
 * scale, with its net total at the tip past the side it ends on.
 *
 * The rows are bars.ts's, from rows.ts, so a stack lays out as bars do and
 * fitTips fits its values. Each segment wears its slot's chart colour, and a
 * 2 px gap of the window's ground parts it from the one before.
 */

import type { StackPlot } from "@document";
import type { Groups, StackTally } from "@engine";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import type { Measured, SplitValue } from "@tally";
import { barsBox, room } from "./bars.ts";
import { OTHER_KEY } from "./pie.ts";
import { ranked, row } from "./rows.ts";

/** The window's ground between two segments of a bar, in px: the dataviz skill's gap. */
export const SEGMENT_GAP = 2;

/** One segment of a bar: the colour it wears, and its size. */
interface Part {
  key: string;
  size: number;
}

/** keyOf gives what slot `i` wears: its chart colour, or Other's past the last. */
export function keyOf(i: number, series: number): string {
  return i < series ? `var(--chart-${i + 1})` : OTHER_KEY;
}

/** asGroups gives a stack's values as a bar chart's groups, each by its total. */
function asGroups(tally: StackTally): Groups {
  const groups = tally.values.map(({ value, total }) => ({ value, ...total }));
  return { ...tally, groups };
}

/**
 * stack draws `tally` as rows or sums per value and series, as `plot`
 * measures them, in a plot `height` px high.
 */
export function stack(plot: StackPlot, tally: StackTally, height: number): HTMLElement {
  const measure = (m: Measured): number => (plot.sum === undefined ? m.rows : m.sum);
  const { shown, lines } = ranked(asGroups(tally), height);
  const series = tally.series.length;
  const drawn = tally.values.slice(0, shown.length).map((v: SplitValue) => {
    const parts = [...v.cells, v.other].map((cell, i): Part => ({
      key: keyOf(i, series),
      size: measure(cell),
    }));
    const net = measure(v.total);
    const above = parts.filter(({ size }) => size > 0);
    const under = parts.filter(({ size }) => size < 0);
    return { label: v.value, above, under, net, tip: num(net) };
  });
  const reach = (parts: Part[]) => parts.reduce((all, { size }) => all + Math.abs(size), 0);
  const low = Math.max(0, ...drawn.map(({ under }) => reach(under)));
  const span = Math.max(0, ...drawn.map(({ above }) => reach(above))) + low;
  const share = (size: number): string => `${span === 0 ? 0 : size / span}`;

  const box = barsBox("chart-stack");
  box.style.setProperty("--segment-gap", `${SEGMENT_GAP}px`);
  box.style.setProperty("--zero", share(low));
  box.style.setProperty("--room-above", room(drawn.filter(({ net }) => net >= 0)));
  box.style.setProperty("--room-below", room(drawn.filter(({ net }) => net < 0)));
  for (const { label, above, under, net, tip } of drawn) {
    const track = el("div", "chart-bar-track");
    // The net total stands past the side the value ends on.
    track.classList.toggle("below", net < 0);
    track.style.setProperty("--share", share(reach(net < 0 ? under : above)));
    for (const [parts, side] of [
      [above, "above"],
      [under, "under"],
    ] as const) {
      let from = 0;
      for (const [i, { key, size }] of parts.entries()) {
        const segment = el("div", `chart-segment ${side}`);
        // A part under zero gives the gap at zero where parts above meet it.
        segment.classList.toggle("after", i > 0 || (side === "under" && above.length > 0));
        segment.classList.toggle("end", i === parts.length - 1);
        segment.style.setProperty("--key", key);
        segment.style.setProperty("--from", share(from));
        segment.style.setProperty("--part", share(Math.abs(size)));
        from += Math.abs(size);
        track.append(segment);
      }
    }
    track.append(el("span", "chart-bar-tip", tip));
    box.append(row(label, track));
  }
  box.append(...lines);
  return box;
}
