/**
 * @fileoverview A dot plot: a dot per value at its rows, sum or mean, on one
 * axis over the values shown, so a small difference reads where a bar from
 * zero would hide it. A hairline runs to each dot from the axis's low end,
 * Cleveland's guide, over a gridline at each tick, and its value stands past it.
 */

import type { DotsPlot } from "@document";
import type { GroupsTally, MeanTally } from "@engine";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { axis, tickLabels } from "./axes.ts";
import { SPAN_LEAST, TIP_GAP, barsBox, room } from "./bars.ts";
import { BAR_GAP, BAR_THICK, ranked, row, rowSteps } from "./rows.ts";
import { ACCENT, among, named } from "./tooltip.ts";
import type { Reading, Targets } from "./tooltip.ts";

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

/** placed gives a mark of `kind` that stands `at` its share of the axis. */
function placed(kind: string, at: number): HTMLElement {
  const made = el("span", kind);
  made.style.setProperty("--at", `${at}`);
  return made;
}

/**
 * dots draws `tally` as `plot` measures it in a plot `height` px high: a row
 * per value it holds, a line of what is left out, and the axis's labels under
 * them, which take a row.
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
  const ticks = scale.ticks.map(at);
  const tips = sizes.map((size) => ({ tip: size === undefined ? "" : num(size) }));
  const box = barsBox("chart-dots");
  box.style.setProperty("--tips-room", room(tips.filter(({ tip }) => tip !== "")));
  for (const [i, g] of shown.entries()) {
    const [size, track] = [sizes[i], el("div", "chart-dot-track")];
    track.append(...ticks.map((tick) => placed("chart-dot-line", tick)));
    if (size === undefined) track.append(el("span", "chart-dots-none", m.chart_dots_none()));
    else {
      track.style.setProperty("--at", `${at(size)}`);
      const tip = el("span", "chart-dot-tip", tips[i]!.tip);
      track.append(el("span", "chart-dot-guide"), el("span", "chart-dot"), tip);
    }
    box.append(row(g.value, track));
  }
  box.append(...lines);
  const labels = el("div", "chart-ticks x");
  for (const [i, label] of tickLabels(scale).entries()) {
    label.style.setProperty("--at", `${ticks[i]}`);
    label.style.setProperty("--wide", `${label.textContent!.length}ch`);
    labels.append(label);
  }
  box.style.setProperty("--label-room", `${scale.labels.at(-1)!.length / 2}ch`);
  const under = el("div", "chart-bar-row chart-dots-axis");
  under.append(el("span"), labels);
  box.append(under);
  return box;
}

/**
 * fitDots takes the values out of a drawn dot plot where they would leave
 * its axis under SPAN_LEAST px, so the dots take the whole track, as fitTips
 * does for bars. It measures, so the plot stands in the page by then.
 */
export function fitDots(box: HTMLElement): void {
  const width = box.querySelector(".chart-dot-track")?.getBoundingClientRect().width ?? 0;
  const tips = [...box.querySelectorAll(".chart-dot-tip")];
  const widest = Math.max(0, ...tips.map((tip) => tip.getBoundingClientRect().width));
  if (width === 0 || tips.length === 0 || width - widest - TIP_GAP >= SPAN_LEAST) return;
  for (const tip of tips) tip.remove();
  box.style.setProperty("--tips-room", "0px");
}

/**
 * dotTargets gives the rows of `drawn`, as dots drew `tally` for `plot`: each
 * worth what its dot stands at, named by its value, with its numbers of a mean
 * and its rows of a mean or a sum. Down and Up step the rows.
 */
export function dotTargets(plot: DotsPlot, tally: DotsTally, drawn: HTMLElement): Targets {
  const sizes = measuresOf(plot, tally);
  const rows = [...drawn.querySelectorAll(".chart-bar-row:has(.chart-dot-track)")];
  const all = rows.map((mark, i) => {
    const [g, size] = [tally.groups[i]!, sizes[i]];
    const counted = (count: number, word: string): Reading => ({
      value: num(count),
      label: el("span", "", word),
    });
    const said = (): Reading[] => {
      const own = {
        value: size === undefined ? m.chart_dots_none() : num(size),
        label: named(g.value),
      };
      const rowed = counted(g.rows, m.chart_dots_rows({ count: g.rows }));
      if (tally.t !== "mean") return plot.of === undefined ? [own] : [own, rowed];
      const { numbers } = tally.groups[i]!;
      return [own, counted(numbers, m.chart_dots_numbers({ count: numbers })), rowed];
    };
    const at = mark.querySelector(".chart-dot, .chart-dots-none")!;
    return { mark, at, front: false, key: ACCENT, said };
  });
  return { all, under: among(all, ".chart-bar-row"), ...rowSteps(all.length) };
}
