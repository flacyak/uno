/**
 * @fileoverview A beeswarm: a strip per value, two rows tall or a share of the
 * plot's rows, on one axis over every row's number, each sampled row a dot
 * placed in rank order, so a strip that fills stops at a prefix of its sample.
 */

import type { SwarmTally } from "@engine";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import type { Strip } from "@tally";
import { axis, tickLabels } from "./axes.ts";
import type { Axis } from "./axes.ts";
import { barsBox } from "./bars.ts";
import type { PlotRoom } from "./kind.ts";
import { BAR_GAP, BAR_THICK, row, rowsIn, trackWide } from "./rows.ts";

/** A dot's width, the dataviz skill's marker, in px; two dots' middles stand at least this far apart. */
export const DOT = 8;
/** The least rows of ranked rows a strip takes. */
const STRIP_ROWS = 2;
/** tallOf gives the height in px of a strip of `rows` ranked rows. */
export const tallOf = (rows: number) => rows * BAR_THICK + (rows - 1) * BAR_GAP;
/** The most strips a beeswarm draws; a line counts the rest. */
export const STRIPS_AT_MOST = 8;
/** How far in px² two dots may overlap in a float's rounding. */
const SQUARE_SLACK = 1e-6;

/** A strip a beeswarm draws: what it names, its rows, its strip, and its dots that fit: each a share of the axis and px off the middle. */
export interface Packed {
  label: string;
  rows: number;
  strip: Strip;
  dots: Array<{ at: number; y: number }>;
}

/** spanOf gives the axis over every row of `tally`, and where a number stands along it, as a share. */
export function spanOf(tally: SwarmTally): [Axis, (x: number) => number] {
  const scale = axis(tally.least, tally.most);
  const [low, high] = [scale.ticks[0]!, scale.ticks.at(-1)!];
  return [scale, (x) => (x - low) / (high - low)];
}

/**
 * pack gives the offset from the middle of each dot at `xs` px, placed in
 * turn at the offset nearest the middle that meets no dot before it, above
 * first and then below, within `reach` px; it stops at the first with none.
 */
export function pack(xs: readonly number[], reach: number): number[] {
  const placed: Array<[number, number]> = [];
  let above = true;
  for (const x of xs) {
    const near = placed.filter(([px]) => Math.abs(px - x) < DOT);
    const clear = (y: number) =>
      near.every(([px, py]) => (px - x) ** 2 + (py - y) ** 2 >= DOT ** 2 - SQUARE_SLACK);
    const offsets = near.flatMap(([px, py]) => {
      const dy = Math.sqrt(DOT ** 2 - (px - x) ** 2);
      return [py - dy, py + dy];
    });
    const fits = [0, ...offsets].filter((y) => Math.abs(y) <= reach && clear(y));
    fits.sort((a, b) => Math.abs(a) - Math.abs(b) || (above ? a - b : b - a));
    const y = fits[0];
    if (y === undefined) break;
    if (y !== 0) above = !above;
    placed.push([x, y]);
  }
  return placed.map(([, y]) => y);
}

/**
 * packed gives the strips of `tally` a plot `height` px high in `room` draws,
 * at most STRIPS_AT_MOST, each value's by its rows, then Other's, each named
 * `whole` where the plot names no column of values, with the dots that fit.
 */
export function packed(
  tally: SwarmTally,
  whole: string | undefined,
  room: PlotRoom,
  height: number,
): Packed[] {
  const strips = tally.rest === undefined ? tally.strips : [...tally.strips, tally.rest];
  const labels = strips.map((s) => whole ?? (s === tally.rest ? m.chart_pie_other() : s.value));
  // The axis's labels take a row, and a line of the strips left out another.
  const rows = rowsIn(height) - 1;
  const fit = (r: number) => Math.min(Math.max(Math.floor(r / STRIP_ROWS), 0), STRIPS_AT_MOST);
  const shown = strips.length <= fit(rows) ? strips.length : fit(rows - 1);
  // The strips share the rows the plot holds past the axis's and the line's.
  const line = shown < strips.length ? 1 : 0;
  const each = Math.max(Math.floor((rows - line) / Math.max(shown, 1)), STRIP_ROWS);
  const reach = (tallOf(each) - DOT) / 2;
  const [, at] = spanOf(tally);
  const wide = trackWide(labels.slice(0, shown), room);
  return strips.slice(0, shown).map((strip, i) => {
    const xs = strip.at.map((x) => at(x) * wide);
    const ys = pack(xs, reach);
    const dots = ys.map((y, d) => ({ at: at(strip.at[d]!), y }));
    return { label: labels[i]!, rows: each, strip, dots };
  });
}

/** swarm draws `strips` of `tally`, a line of those left out, and the axis's labels under them. */
export function swarm(strips: readonly Packed[], tally: SwarmTally): HTMLElement {
  const [scale, at] = spanOf(tally);
  const box = barsBox("chart-swarm");
  for (const { label, rows, dots } of strips) {
    const track = el("div", "chart-swarm-track");
    for (const dotted of dots) {
      const dot = el("span", "chart-swarm-dot");
      dot.style.setProperty("--at", `${dotted.at}`);
      dot.style.setProperty("--y", `${dotted.y}px`);
      track.append(dot);
    }
    const strip = row(label, track);
    strip.style.setProperty("--strip-rows", `${rows}`);
    box.append(strip);
  }
  const left = tally.strips.length + (tally.rest === undefined ? 0 : 1) - strips.length;
  if (left > 0) box.append(el("div", "chart-bars-line", m.chart_bars_more({ count: num(left) })));
  const ticks = el("div", "chart-ticks x");
  for (const [i, label] of tickLabels(scale).entries()) {
    label.style.setProperty("--at", `${at(scale.ticks[i]!)}`);
    label.style.setProperty("--wide", `${label.textContent!.length}ch`);
    ticks.append(label);
  }
  const under = el("div", "chart-bar-row chart-box-axis");
  under.append(el("span"), ticks);
  box.append(under);
  return box;
}
