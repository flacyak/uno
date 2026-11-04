/**
 * @fileoverview A scatter chart: a point per sampled row, where its x and y
 * stand on two axes that take in every plotted row, over a gridline at each
 * tick. The y axis's labels stand left of the plot, and the x axis's under it.
 *
 * The points and gridlines are SVG placed in shares of the plot, so chart.css
 * sizes it and a theme recolours them. Each point wears the accent at a low
 * opacity, so where points crowd the accent shows deeper. The labels are HTML
 * placed in the same shares, and mono, so the room they take is their length
 * in ch.
 */

import type { Sample } from "@engine";
import { el } from "@renderer/shell/util";
import { axis, gutter, tickLabels } from "./axes.ts";
import type { Axis } from "./axes.ts";
import { BARS_INSET, TIP_GAP } from "./bars.ts";

/** A point's radius, in px: the dataviz skill's least marker, 8 px across. */
export const POINT_RADIUS = 4;

/**
 * How much of the accent a point wears: where ten lie over one another the
 * accent shows almost whole, so a crowd reads as density. A lone point stands
 * at 1.5:1 to 1.8:1 on --surface, under the 3:1 a mark wants.
 */
export const POINT_OPACITY = 0.3;

/** The namespace an SVG element is made in. */
const SVG = "http://www.w3.org/2000/svg";

/** mark makes an SVG `tag` of class `cls`. */
function mark<K extends keyof SVGElementTagNameMap>(tag: K, cls: string): SVGElementTagNameMap[K] {
  const made = document.createElementNS(SVG, tag);
  made.setAttribute("class", cls);
  return made;
}

/** share gives where `value` stands on `axis`, from 0 at its first tick to 1 at its last. */
function share(axis: Axis, value: number): number {
  const low = axis.ticks[0]!;
  return (value - low) / (axis.ticks.at(-1)! - low);
}

/** percent writes `share` of the plot as SVG takes it. */
function percent(share: number): string {
  return `${share * 100}%`;
}

/**
 * scales says whether `axis` gives a scale: two ticks or more, each finite, and
 * a span between them that a double holds.
 */
function scales(axis: Axis): boolean {
  const { ticks } = axis;
  const span = ticks.at(-1)! - ticks[0]!;
  return ticks.length >= 2 && ticks.every(Number.isFinite) && Number.isFinite(span);
}

/** gridline gives a line across the plot from `x1`, `y1` to `x2`, `y2`. */
function gridline(cls: string, x1: string, y1: string, x2: string, y2: string): SVGLineElement {
  const line = mark("line", `chart-grid ${cls}`);
  for (const [name, at] of Object.entries({ x1, y1, x2, y2 })) line.setAttribute(name, at);
  return line;
}

/**
 * writeAlong writes `x`'s labels under `box`'s points, each at its tick's share.
 * A label centres on its tick, so the first and last reach half their length
 * past the points.
 */
function writeAlong(box: HTMLElement, x: Axis): void {
  const labels = tickLabels(x);
  for (const [i, label] of labels.entries()) label.style.left = percent(share(x, x.ticks[i]!));
  box.querySelector(".chart-ticks.x")!.replaceChildren(...labels);
  box.style.setProperty("--x-first", `${x.labels[0]!.length / 2}ch`);
  box.style.setProperty("--x-last", `${x.labels.at(-1)!.length / 2}ch`);
}

/**
 * scatter draws `sample`'s points against axes over its least and most. A
 * tally that plotted nothing has no extent to draw, and where no double can
 * scale an axis its points would stand at NaN, so either draws nothing.
 */
export function scatter(sample: Sample): HTMLElement {
  const box = el("div", "chart-scatter");
  const x = axis(sample.least.x, sample.most.x);
  const y = axis(sample.least.y, sample.most.y);
  if (sample.plotted === 0 || !scales(x) || !scales(y)) return box;

  const plot = mark("svg", "chart-points");
  plot.setAttribute("aria-hidden", "true");
  plot.style.setProperty("--point-opacity", `${POINT_OPACITY}`);
  const up = el("div", "chart-ticks y");
  for (const tick of x.ticks) {
    const at = percent(share(x, tick));
    plot.append(gridline("x", at, "0", at, "100%"));
  }
  // SVG counts down from the top, and an axis up from its first tick.
  for (const [i, label] of tickLabels(y).entries()) {
    const at = percent(1 - share(y, y.ticks[i]!));
    plot.append(gridline("y", "0", at, "100%", at));
    label.style.top = at;
    up.append(label);
  }
  for (const [i, at] of sample.x.entries()) {
    const point = mark("circle", "chart-point");
    point.setAttribute("cx", percent(share(x, at)));
    point.setAttribute("cy", percent(1 - share(y, sample.y[i]!)));
    point.setAttribute("r", `${POINT_RADIUS}`);
    plot.append(point);
  }
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--gutter", `${gutter(y)}ch`);
  box.style.setProperty("--tick-gap", `${TIP_GAP}px`);
  box.append(up, plot, el("div", "chart-ticks x"));
  writeAlong(box, x);
  return box;
}
