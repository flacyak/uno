/**
 * @fileoverview What a chart says of one of its marks, under the pointer or
 * stepped to with the keys: what the mark is worth, as readings of a value
 * and what it is of, under the colour the mark wears. A bar's row is its hit
 * target, a slice its own shape, and a point snaps to the nearest within
 * HIT_RADIUS, so none has to be hit dead on.
 *
 * A value from the file is set as text alone, and a number is written in the
 * app's language.
 */

import type { ChartColumn, Plot } from "@document";
import type { Groups, GroupsTally, Sample, SampleTally } from "@engine";
import { m } from "@paraglide/messages";
import { columnLabel, unnamed } from "@renderer/grid/rows";
import { num, percent } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { slices, wholeOf } from "./pie.ts";

/**
 * How near a pointer has to come to a point, in px: half the dataviz skill's
 * least hit area, 24 px across.
 */
export const HIT_RADIUS = 12;

/** What the bars and the points wear, as the box's key. */
const ACCENT = "var(--accent)";

/** What parts a label's words, as the caption's. */
const SEP = " · ";

/** What a share of the whole reads as, where scatter.ts wrote it as a percent. */
const WHOLE_PERCENT = 100;

/** What a bar chart, a pie and a scatter draw. */
type Bars = Extract<Plot, { t: "bars" }>;
type Pie = Extract<Plot, { t: "pie" }>;
type Scatter = Extract<Plot, { t: "scatter" }>;

/** One of a mark's readings: a number, and what it is of. */
export interface Reading {
  value: string;
  label: Node;
}

/** A mark a person can point at or step to. */
export interface Target {
  /** The mark that wears the cursor. */
  mark: Element;
  /** The mark the box stands by when the keys step to it. */
  at: Element;
  /** The colour the mark wears, as CSS. */
  key: string;
  /** What the mark is worth, read when the box says it. */
  said: () => Reading[];
}

/** The marks of a drawing, in the order the keys step through them. */
export interface Targets {
  all: Target[];
  /**
   * Which of `all` a pointer at `x`, `y` is over, where `hit` is what it is
   * over, or none.
   */
  under: (hit: EventTarget | null, x: number, y: number) => number | undefined;
}

/** The marks of nothing a pointer can point at. */
export const NONE: Targets = { all: [], under: () => undefined };

/**
 * named gives a value as the box says it: the file's text, marked as the
 * file's, or the app's word for the rows whose cell is blank.
 */
function named(value: string): HTMLElement {
  if (value === "") return el("span", "", m.chart_blank_value());
  return el("bdi", "from-file", value);
}

/**
 * column gives a column's name as the box says it: the file's header, marked
 * as the file's, or the app's name for one with none.
 */
function column({ header, col }: ChartColumn): HTMLElement {
  const label = columnLabel(header, col);
  return unnamed(header) ? el("span", "", label) : el("bdi", "from-file", label);
}

/** among gives the hit test of `all`, whose marks are the `selector` a pointer is over. */
function among(all: readonly Target[], selector: string): Targets["under"] {
  return (hit) => {
    const mark = hit instanceof Element ? hit.closest(selector) : null;
    const at = all.findIndex((target) => target.mark === mark);
    return at === -1 ? undefined : at;
  };
}

/**
 * barTargets gives the targets of `box`, as bars drew `groups` for `plot`:
 * each value's row, worth the rows it counts or the sum of its cells. The
 * box stands by the bar's value, or by the bar where the plot has no room
 * for values.
 */
export function barTargets(plot: Bars, groups: Groups, box: HTMLElement): Targets {
  const measure = (g: { rows: number; sum: number }): number =>
    plot.sum === undefined ? g.rows : g.sum;
  const all = [...box.querySelectorAll(".chart-bar-row")].map((row, i) => {
    const g = groups.groups[i]!;
    return {
      mark: row,
      at: row.querySelector(".chart-bar-tip") ?? row.querySelector(".chart-bar")!,
      key: ACCENT,
      said: () => [{ value: num(measure(g)), label: named(g.value) }],
    };
  });
  return { all, under: among(all, ".chart-bar-row") };
}

/**
 * sliceTargets gives the targets of `box`, as pie drew `groups` for `plot`:
 * each slice, worth what it measures, labelled by its value, or the app's
 * word for Other, and its share of the whole.
 */
export function sliceTargets(plot: Pie, groups: Groups, box: HTMLElement): Targets {
  const drawn = slices(plot, groups);
  const whole = wholeOf(drawn);
  const all = [...box.querySelectorAll<SVGElement>(".chart-slice")].map((slice, i) => {
    const { value, size } = drawn[i]!;
    const said = (): Reading[] => {
      const label = el("span");
      const name = value === undefined ? el("span", "", m.chart_pie_other()) : named(value);
      label.append(name, `${SEP}${percent(size / whole)}`);
      return [{ value: num(size), label }];
    };
    return { mark: slice, at: slice, key: slice.style.getPropertyValue("--key"), said };
  });
  return { all, under: among(all, ".chart-slice") };
}

/** share reads where a point stands along `name`, as a share of the plot. */
function share(point: Element, name: string): number {
  return parseFloat(point.getAttribute(name) ?? "") / WHOLE_PERCENT;
}

/**
 * pointTargets gives the targets of `box`, as scatter drew `sample` for
 * `plot`: each point, worth its x and its y, named by their columns. The
 * target of a pointer is the nearest point within HIT_RADIUS of it.
 */
export function pointTargets(plot: Scatter, sample: Sample, box: HTMLElement): Targets {
  const points = [...box.querySelectorAll(".chart-point")];
  const all = points.map((point, i) => ({
    mark: point,
    at: point,
    key: ACCENT,
    said: () => [
      { value: num(sample.x[i]!), label: column(plot.x) },
      { value: num(sample.y[i]!), label: column(plot.y) },
    ],
  }));
  const shares = points.map((point) => ({ x: share(point, "cx"), y: share(point, "cy") }));
  const svg = box.querySelector(".chart-points");
  const under = (_hit: EventTarget | null, x: number, y: number): number | undefined => {
    if (svg === null) return undefined;
    const { left, top, width, height } = svg.getBoundingClientRect();
    let near: number | undefined;
    let least = HIT_RADIUS ** 2;
    for (const [i, at] of shares.entries()) {
      const apart = (left + at.x * width - x) ** 2 + (top + at.y * height - y) ** 2;
      if (apart <= least) {
        least = apart;
        near = i;
      }
    }
    return near;
  };
  return { all, under };
}

/**
 * targets gives the marks of `drawn`, as `plot` reads `tally`, or none of a
 * drawing of another kind.
 */
export function targets(plot: Plot, tally: GroupsTally | SampleTally, drawn: HTMLElement): Targets {
  if (plot.t === "bars" && tally.t === "groups") return barTargets(plot, tally, drawn);
  if (plot.t === "pie" && tally.t === "groups") return sliceTargets(plot, tally, drawn);
  if (plot.t === "scatter" && tally.t === "sample") return pointTargets(plot, tally, drawn);
  return NONE;
}
