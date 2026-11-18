/**
 * @fileoverview What a chart says it shows, in a sentence: its title, its
 * source and its rows, then the largest values with what each measures and a
 * count of the rest, or the points a scatter plots and what its axes span. A
 * screen reader hears it as the drawing's name, so it says the exact values
 * the marks only show.
 *
 * The app's words follow the language, and the values from the file stand
 * apart from them, so a window can mark them as the file's.
 */

import type { ChartColumn, Plot, TimePlot } from "@document";
import type { Group, Groups, Sample } from "@engine";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { list, num, percent } from "@renderer/locale";
import type { TimeLevel } from "@tally";
import { fullName } from "./periods.ts";
import { slices, wholeOf } from "./pie.ts";

/** How many values a summary names before it counts the rest: three, as a sentence reads. */
export const SUMMARY_VALUES = 3;

/** What a chart says it shows. */
export interface Summary {
  /** The app's words: the title, the source and the rows, then what a scatter spans. */
  said: string;
  /** The values from the file, each with what it measures, or nothing for a scatter. */
  values: string;
  /** The app's count of the values past those named, or nothing. */
  more: string;
}

/** What a kind says of its tally, past its rows. */
export interface Told {
  /** The app's words after the rows: what a scatter's axes span, or nothing. */
  span: string;
  /** The values from the file, the largest first, each with what it measures. */
  each: string[];
  /** How many values come after the SUMMARY_VALUES named. */
  more: number;
}

/** What a bars or pie chart draws. */
type Grouped = Extract<Plot, { t: "bars" | "pie" }>;

/** named gives a value as the summary says it: the file's text, or the app's word for a blank cell. */
function named(value: string): string {
  return value === "" ? m.chart_blank_value() : value;
}

/**
 * valued gives a tally's values as `plot` measures them, the largest first,
 * each with its rows or sum, or each slice with its share for a pie, and how
 * many come after the SUMMARY_VALUES named, with those a snapshot left out.
 */
export function valued(plot: Grouped, tally: Groups): Told {
  if (plot.t === "pie") {
    const drawn = slices(plot, tally);
    const whole = wholeOf(drawn);
    const each = drawn.map(({ value, size }) => {
      const name = value === undefined ? m.chart_pie_other() : named(value);
      return whole > 0 ? `${name} ${percent(size / whole)}` : name;
    });
    return { span: "", each, more: Math.max(drawn.length - SUMMARY_VALUES, 0) };
  }
  const measure = (g: Group): number => (plot.sum === undefined ? g.rows : g.sum);
  const each = tally.groups.map((g) => `${named(g.value)} ${num(measure(g))}`);
  const { others, below } = tally;
  const more = Math.max(each.length - SUMMARY_VALUES, 0) + others.values + below.values;
  return { span: "", each, more };
}

/** spanned gives what a scatter's summary says of its points, and of what its axes span. */
export function spanned(plot: Extract<Plot, { t: "scatter" }>, tally: Sample): Told {
  const label = ({ header, col }: ChartColumn): string => columnLabel(header, col);
  const { least, most } = tally;
  const span = m.chart_summary_points({
    points: m.chart_points({ count: tally.plotted }),
    x: label(plot.x),
    xLeast: num(least.x),
    xMost: num(most.x),
    y: label(plot.y),
    yLeast: num(least.y),
    yMost: num(most.y),
  });
  return { span, each: [], more: 0 };
}

/**
 * spannedOver gives what an over-time chart's summary says of `level`, as
 * `plot` measures it: its first period and its last, and the one that holds
 * the most, with what it holds.
 */
export function spannedOver({ sum }: TimePlot, level: TimeLevel): Told {
  const sizes = sum === undefined ? level.rows : level.sum;
  const most = sizes.reduce((at, size, i) => (size > sizes[at]! ? i : at), 0);
  const name = (i: number): string => fullName(level.per, level.from + i);
  const value = num(sizes[most]!);
  const span = m.chart_summary_time({
    from: name(0),
    to: name(level.span - 1),
    most: name(most),
    value,
  });
  return { span, each: [], more: 0 };
}

/**
 * summaryOf gives what a chart called `title`, over the file `name`, says it
 * shows of a tally of `rows`, which its kind has `told`: the values from the
 * file apart from the app's words.
 */
export function summaryOf(title: string, name: string, rows: number, told?: Told): Summary {
  const said = m.chart_summary({ title, name, rows: m.rows_count({ count: rows }) });
  if (told === undefined) return { said, values: "", more: "" };
  const { span, each, more } = told;
  return {
    said: span === "" ? said : `${said} ${span}`,
    values: list(each.slice(0, SUMMARY_VALUES)),
    more: more > 0 ? m.chart_summary_more({ count: num(more) }) : "",
  };
}
