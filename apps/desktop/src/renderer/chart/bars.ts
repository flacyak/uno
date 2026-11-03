/**
 * @fileoverview A bar chart: a bar per value, the largest first, each as long
 * as its share of the largest, with the value at its tip.
 *
 * The bars are HTML, so a theme recolours them and a zoom keeps them crisp. A
 * label is the file's text, set as text alone. The values are mono, so the room
 * they take is their length in ch.
 */

import type { Plot } from "@document";
import type { Group, Groups } from "@engine";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";

/** What a bar chart draws. */
type Bars = Extract<Plot, { t: "bars" }>;

/** bars draws `groups` as rows or sums per value, as `plot` measures them. */
export function bars(plot: Bars, groups: Groups): HTMLElement {
  const measure = (g: Group): number => (plot.sum === undefined ? g.rows : g.sum);
  const drawn = groups.groups.map((g) => ({
    label: g.value,
    size: measure(g),
    tip: num(measure(g)),
  }));
  const largest = Math.max(0, ...drawn.map(({ size }) => size));
  const widest = Math.max(0, ...drawn.map(({ tip }) => tip.length));

  const box = el("div", "chart-bars");
  box.style.setProperty("--tip-room", `${widest}ch`);
  for (const { label, size, tip } of drawn) {
    const track = el("div", "chart-bar-track");
    track.style.setProperty("--share", `${largest === 0 ? 0 : size / largest}`);
    track.append(el("div", "chart-bar"), el("span", "chart-bar-tip", tip));
    box.append(el("bdi", "chart-bar-label from-file", label), track);
  }
  return box;
}
