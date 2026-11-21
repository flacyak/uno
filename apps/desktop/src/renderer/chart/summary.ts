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

import type {
  ChartColumn,
  ChordPlot,
  ParallelPlot,
  Plot,
  StackPlot,
  SwarmPlot,
  TimePlot,
} from "@document";
import type {
  ChordTally,
  Group,
  Groups,
  HeatTally,
  ParallelTally,
  Sample,
  StackTally,
  SwarmTally,
  WeekTally,
} from "@engine";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { list, num, percent, places } from "@renderer/locale";
import { WEEK_DAYS } from "@tally";
import type { Box, Level, SplitLevel, TimeLevel } from "@tally";
import { edgeWords } from "./histogram.ts";
import { dayName, fullName } from "./periods.ts";
import { slices, wholeOf } from "./pie.ts";
import { amountsOf, slotsOf } from "./week.ts";

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

/**
 * split gives what a stacked chart's summary says of its tally: the column
 * that splits its bars and how many series it draws, Other one of them, and
 * its values by their totals, as a bar chart's.
 */
/**
 * flowed gives what a chord chart's summary says: its largest flow between two
 * nodes, and each node, Other last, with what it runs to the others.
 */
export function flowed(plot: ChordPlot, tally: ChordTally): Told {
  const measure = (g: { rows: number; sum: number }): number =>
    plot.sum === undefined ? g.rows : g.sum;
  const name = (place: number) => named(tally.nodes[place] ?? m.chart_pie_other());
  const flows = tally.flows.flatMap((out, p) =>
    out.map((flow, q) => ({ p, q, size: measure(flow) })),
  );
  const largest = flows.reduce((most, flow) => (flow.size > most.size ? flow : most));
  const span = m.chart_summary_chord({
    from: name(largest.p),
    to: name(largest.q),
    value: num(largest.size),
  });
  const each = tally.flows.map(
    (out, p) => `${name(p)} ${num(out.reduce((n, flow) => n + measure(flow), 0))}`,
  );
  return { span, each, more: Math.max(each.length - SUMMARY_VALUES, 0) };
}

export function split(plot: StackPlot, tally: StackTally): Told {
  const measure = (g: { rows: number; sum: number }): number =>
    plot.sum === undefined ? g.rows : g.sum;
  const other = tally.values.some((v) => v.other.rows > 0) ? 1 : 0;
  const count = num(tally.series.length + other);
  const span = m.chart_summary_stack({
    split: columnLabel(plot.split.header, plot.split.col),
    count,
  });
  const each = tally.values.map((v) => `${named(v.value)} ${num(measure(v.total))}`);
  const more = Math.max(each.length - SUMMARY_VALUES, 0) + tally.others.values + tally.below.values;
  return { span, each, more };
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
export function spannedOver({ sum }: Pick<TimePlot, "sum">, level: TimeLevel): Told {
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
 * weekOver gives what a week heatmap's summary says of `tally`, past its rows:
 * its days, and the hour of the most rows, or the largest sum where `summed`.
 */
export function weekOver(tally: WeekTally, summed: boolean): Told {
  const slots = slotsOf(tally);
  const sizes = amountsOf(slots, summed);
  const most = sizes.reduce((at, size, i) => (size > sizes[at]! ? i : at), 0);
  const [from, to] = [dayName(0, "long"), dayName(WEEK_DAYS - 1, "long")];
  const value = num(sizes[most]!);
  const span = m.chart_summary_time({ from, to, most: slots.nameOf(most), value });
  return { span, each: [], more: 0 };
}

/**
 * heatOver gives what a heatmap's summary says of `level` of `tally`, past its
 * rows: its first and last period, and the value and period of the most rows,
 * or the largest sum where `summed`.
 */
export function heatOver(tally: HeatTally, level: SplitLevel, summed: boolean): Told {
  const sizes = (summed ? level.sum : level.rows).flatMap((each, i) =>
    each.map((size, p) => ({ size, i, p })),
  );
  const most = sizes.reduce((at, cell) => (cell.size > at.size ? cell : at), sizes[0]!);
  const name = (p: number): string => fullName(level.per, level.from + p);
  const value = tally.values[most.i]!.value || m.chart_blank_value();
  const span = m.chart_summary_time({
    from: name(0),
    to: name(level.span - 1),
    most: `${value}, ${name(most.p)}`,
    value: num(most.size),
  });
  return { span, each: [], more: 0 };
}

/**
 * binnedOver gives what a histogram's summary says of `level`, past its rows:
 * the edges of its span, its bins' width, the bin of the span with the most
 * rows, and the median of `box`.
 */
export function binnedOver(level: Level, box: Box): Told {
  const { at, spans, rows } = level;
  const inSpan = (i: number) => i >= at && i < at + spans;
  const most = rows.reduce((top, n, i) => (inSpan(i) && n > rows[top]! ? i : top), at);
  const words = (i: number) => edgeWords(level, i);
  const span = m.chart_summary_histogram({
    from: words(at),
    to: words(at + spans),
    step: places(Number(`${level.step}e${level.power}`), -level.power),
    most: m.chart_bin({ from: words(most), to: words(most + 1) }),
    value: num(rows[most]!),
    median: num(box.five[2]![0]),
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

/**
 * swarmOver gives what a beeswarm's summary says past its rows: how many rows
 * it plots and its number's least and most, then its strips, the most rows
 * first, each with its rows, and how many come after the SUMMARY_VALUES named.
 */
export function swarmOver(plot: SwarmPlot, tally: SwarmTally): Told {
  const span = m.chart_summary_swarm({
    rows: m.rows_count({ count: tally.plotted }),
    of: columnLabel(plot.of.header, plot.of.col),
    least: num(tally.least),
    most: num(tally.most),
  });
  if (plot.by === undefined) return { span, each: [], more: 0 };
  const each = tally.strips.map((s) => `${named(s.value)} ${num(s.plotted)}`);
  if (tally.rest !== undefined) each.push(`${m.chart_pie_other()} ${num(tally.rest.plotted)}`);
  return { span, each, more: Math.max(each.length - SUMMARY_VALUES, 0) };
}

/** parallelOver gives what parallel coordinates' summary says past their rows: how many rows they plot, and each axis's least and most. */
export function parallelOver(plot: ParallelPlot, tally: ParallelTally): Told {
  const axes = plot.axes.map(({ header, col }, i) =>
    m.chart_axis_from_to({
      of: columnLabel(header, col),
      least: num(tally.least[i]!),
      most: num(tally.most[i]!),
    }),
  );
  const rows = m.rows_count({ count: tally.plotted });
  return { span: m.chart_summary_parallel({ rows, axes: list(axes) }), each: [], more: 0 };
}
