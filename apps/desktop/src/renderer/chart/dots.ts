/**
 * @fileoverview A dot plot: a dot per value at its rows, sum or mean, on one
 * axis over the values shown, so a small difference reads where a bar from
 * zero would hide it.
 */

import type { DotsPlot } from "@document";
import type { GroupsTally, MeanTally } from "@engine";
import { m } from "@paraglide/messages";
import { el } from "@renderer/shell/util";
import { axis } from "./axes.ts";
import { barsBox } from "./bars.ts";
import { BAR_GAP, BAR_THICK, ranked, row } from "./rows.ts";

/** A tally a dot plot draws: rows or a sum per value, or a mean. */
export type DotsTally = GroupsTally | MeanTally;

/**
 * measuresOf gives what each of `tally`'s values measures as `plot` reads
 * it, in the order sent: its rows, its sum, or its mean, none for a mean of
 * no number.
 */
export function measuresOf(plot: DotsPlot, tally: DotsTally): Array<number | undefined> {
  if (tally.t === "mean") {
    return tally.groups.map(({ sum, numbers }) => (numbers === 0 ? undefined : sum / numbers));
  }
  return tally.groups.map((g) => (plot.of === undefined ? g.rows : g.sum));
}

/**
 * dots draws `tally` as `plot` measures it in a plot `height` px high: a row
 * per value it holds and a line of what is left out, leaving a row under them
 * for the axis's labels.
 */
export function dots(plot: DotsPlot, tally: DotsTally, height: number): HTMLElement {
  const { shown, lines } = ranked(tally, height - BAR_THICK - BAR_GAP);
  const sizes = measuresOf(plot, tally).slice(0, shown.length);
  const finite = sizes.filter(
    (size): size is number => size !== undefined && Number.isFinite(size),
  );
  const scale = finite.length === 0 ? axis(0, 0) : axis(Math.min(...finite), Math.max(...finite));
  const [low, high] = [scale.ticks[0]!, scale.ticks.at(-1)!];
  const at = (x: number) => Math.min(Math.max((x - low) / (high - low), 0), 1);
  const box = barsBox("chart-dots");
  for (const [i, g] of shown.entries()) {
    const [size, track] = [sizes[i], el("div", "chart-dot-track")];
    if (size === undefined) track.append(el("span", "chart-dots-none", m.chart_dots_none()));
    else {
      track.style.setProperty("--at", `${at(size)}`);
      track.append(el("span", "chart-dot"));
    }
    box.append(row(g.value, track));
  }
  box.append(...lines);
  return box;
}
