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
import type { PlotRoom } from "./kind.ts";
import {
  ENTRY_GAP,
  KEY_GAP,
  KEY_SIZE,
  LEGEND_LINE,
  LEGEND_NAME_AT_MOST,
  legend,
} from "./legend.ts";
import { OTHER_KEY } from "./pie.ts";
import { BARS_INSET, ranked, row } from "./rows.ts";

/** The window's ground between two segments of a bar, in px: the dataviz skill's gap. */
export const SEGMENT_GAP = 2;

/** One segment of a bar: the colour it wears, and its size. */
interface Part {
  key: string;
  size: number;
  slot: number;
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
 * keyed gives a stack's legend over its bars, and the height it takes from
 * the plot: a key per series, then Other where a value has rows in it. One
 * series alone has none, as the title names it.
 */
function keyed(
  tally: StackTally,
  plot: PlotRoom,
  height: number,
): { box: HTMLElement; height: number } {
  const { series, values } = tally;
  const other = values.some((v) => v.other.rows > 0) ? [undefined] : [];
  const entries = [...series, ...other].map((name, i) => ({
    key: keyOf(i, series.length),
    series: name,
  }));
  if (entries.length < 2) return { box: el("div"), height: 0 };
  const keys = legend(entries, plot, height);
  keys.box.style.setProperty("--bars-inset", `${BARS_INSET}px`);
  keys.box.style.setProperty("--key-size", `${KEY_SIZE}px`);
  keys.box.style.setProperty("--key-gap", `${KEY_GAP}px`);
  keys.box.style.setProperty("--entry-gap", `${ENTRY_GAP}px`);
  keys.box.style.setProperty("--legend-line", `${LEGEND_LINE}px`);
  keys.box.style.setProperty("--name-most", `${LEGEND_NAME_AT_MOST}ch`);
  return keys;
}

/**
 * stack draws `tally` as rows or sums per value and series, as `plot`
 * measures them, in a plot `height` px high and as wide as `across`, its legend over
 * its bars.
 */
export function stack(
  plot: StackPlot,
  tally: StackTally,
  height: number,
  across: PlotRoom,
): HTMLElement {
  const measure = (m: Measured): number => (plot.sum === undefined ? m.rows : m.sum);
  const keys = keyed(tally, across, height);
  const { shown, lines } = ranked(asGroups(tally), height - keys.height);
  const series = tally.series.length;
  const drawn = tally.values.slice(0, shown.length).map((v: SplitValue) => {
    const parts = [...v.cells, v.other].map((cell, slot): Part => ({
      key: keyOf(slot, series),
      size: measure(cell),
      slot,
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
      for (const [i, { key, size, slot }] of parts.entries()) {
        const segment = el("div", `chart-segment ${side}`);
        // A part under zero gives the gap at zero where parts above meet it.
        segment.classList.toggle("after", i > 0 || (side === "under" && above.length > 0));
        segment.classList.toggle("end", i === parts.length - 1);
        segment.style.setProperty("--key", key);
        segment.dataset["slot"] = String(slot);
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
  const whole = el("div", "chart-stacked");
  whole.append(keys.box, box);
  return whole;
}
