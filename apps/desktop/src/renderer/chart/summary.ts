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

import type { ChartColumn, Plot } from "@document";
import type { Group, GroupsTally, SampleTally } from "@engine";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { list, num, percent } from "@renderer/locale";
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

/** What a bars or pie chart draws. */
type Grouped = Exclude<Plot, { t: "scatter" }>;

/** named gives a value as the summary says it: the file's text, or the app's word for a blank cell. */
function named(value: string): string {
  return value === "" ? m.chart_blank_value() : value;
}

/**
 * valued gives a tally's values as `plot` measures them, the largest first,
 * each with its rows or sum, or each slice with its share for a pie, and how
 * many come after the SUMMARY_VALUES named, with those a snapshot left out.
 */
function valued(plot: Grouped, tally: GroupsTally): { each: string[]; more: number } {
  if (plot.t === "pie") {
    const drawn = slices(plot, tally);
    const whole = wholeOf(drawn);
    const each = drawn.map(({ value, size }) => {
      const name = value === undefined ? m.chart_pie_other() : named(value);
      return whole > 0 ? `${name} ${percent(size / whole)}` : name;
    });
    return { each, more: Math.max(drawn.length - SUMMARY_VALUES, 0) };
  }
  const measure = (g: Group): number => (plot.sum === undefined ? g.rows : g.sum);
  const each = tally.groups.map((g) => `${named(g.value)} ${num(measure(g))}`);
  const { others, below } = tally;
  const more = Math.max(each.length - SUMMARY_VALUES, 0) + others.values + below.values;
  return { each, more };
}

/** spanned gives what a scatter's summary says of its points, and of what its axes span. */
function spanned(plot: Extract<Plot, { t: "scatter" }>, tally: SampleTally): string {
  const label = ({ header, col }: ChartColumn): string => columnLabel(header, col);
  const { least, most } = tally;
  return m.chart_summary_points({
    points: m.chart_points({ count: tally.plotted }),
    x: label(plot.x),
    xLeast: num(least.x),
    xMost: num(most.x),
    y: label(plot.y),
    yLeast: num(least.y),
    yMost: num(most.y),
  });
}

/**
 * summary gives what a chart called `title`, over the file `name`, says it
 * shows of `tally`, which `plot` reads: the values from the file apart from
 * the app's words.
 */
export function summary(
  title: string,
  name: string,
  plot: Plot,
  tally: GroupsTally | SampleTally,
): Summary {
  const said = m.chart_summary({ title, name, rows: m.rows_count({ count: tally.coverage.rows }) });
  if (plot.t === "scatter") {
    const span = tally.t === "sample" ? ` ${spanned(plot, tally)}` : "";
    return { said: `${said}${span}`, values: "", more: "" };
  }
  if (tally.t !== "groups") return { said, values: "", more: "" };
  const { each, more } = valued(plot, tally);
  return {
    said,
    values: list(each.slice(0, SUMMARY_VALUES)),
    more: more > 0 ? m.chart_summary_more({ count: num(more) }) : "",
  };
}
