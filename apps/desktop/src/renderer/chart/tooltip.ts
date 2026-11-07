/**
 * @fileoverview What a chart says of one of its marks, under the pointer or
 * stepped to with the keys: what the mark is worth, as readings of a value
 * and what it is of, under the colour the mark wears. A bar's row is its hit
 * target.
 *
 * A value from the file is set as text alone, and a number is written in the
 * app's language.
 */

import type { Plot } from "@document";
import type { Groups } from "@engine";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";

/** What the bars and the points wear, as the box's key. */
const ACCENT = "var(--accent)";

/** What a bar chart draws. */
type Bars = Extract<Plot, { t: "bars" }>;

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
