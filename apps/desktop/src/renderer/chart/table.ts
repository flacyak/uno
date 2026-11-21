/**
 * @fileoverview A chart's table: every value its tally sent with what it
 * measures, the largest first, and the values left out counted after them,
 * or each point a scatter drew. It is the text alternative to the drawing:
 * it gives the exact numbers, a finger scrolls it, a person selects from it,
 * and a screen reader walks it as a table, under a caption that says what
 * the chart is called, its headers naming the columns.
 *
 * It is HTML chart.css lays out as the window's scroller. A value is the
 * file's text, set as text alone, and a number is in the app's language.
 */

import type {
  ChartColumn,
  DotsPlot,
  HeatPlot,
  Plot,
  SlopePlot,
  StackPlot,
  TimePlot,
  WeekPlot,
} from "@document";
import { DISTINCT_AT_MOST } from "@engine";
import type {
  BoxTally,
  Groups,
  Sample,
  SlopeTally,
  SpreadTally,
  StackTally,
  TimeTally,
  WeekTally,
  HeatTally,
} from "@engine";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { num, percent } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import type { Level, SplitLevel, TimeLevel } from "@tally";
import { SEP, blank, notNumbers } from "./caption.ts";
import { middle } from "./box.ts";
import { measuresOf } from "./dots.ts";
import { endsOf } from "./slope.ts";
import { slotsOf } from "./week.ts";
import type { DotsTally } from "./dots.ts";
import type { Boxed } from "./box.ts";
import { edgeWords } from "./histogram.ts";
import { PER_WORDS, clockName, dayName, label } from "./periods.ts";
import { PIE_SLICES_AT_MOST, slices, unsent, wholeOf } from "./pie.ts";

/** What a tally measures of a value, or of the values it leaves out: their rows and their sum. */
type Measured = Pick<Groups["rest"], "rows" | "sum">;

/** words writes `text` in `cell`: the file's, in a bdi marked as the file's, or the app's. */
function words(cell: HTMLTableCellElement, text: string, fromFile: boolean): HTMLTableCellElement {
  if (fromFile) cell.append(el("bdi", "from-file", text));
  else cell.textContent = text;
  return cell;
}

/** header gives a column's header of `text`, the file's or the app's, over the digits' column if `digits`. */
function header(text: string, fromFile: boolean, digits = false): HTMLTableCellElement {
  const th = el("th", digits ? "num" : "");
  th.scope = "col";
  return words(th, text, fromFile);
}

/** rowHead gives a row's header of `value`: the file's text, or the app's word for a blank cell. */
function rowHead(value: string): HTMLTableCellElement {
  const blank = value === "";
  const th = el("th", blank ? "chart-blank" : "");
  th.scope = "row";
  return blank ? words(th, m.chart_blank_value(), false) : words(th, value, true);
}

/** digits gives a cell of `n` in the app's language, in the digits' column. */
function digits(n: number): HTMLTableCellElement {
  return el("td", "num", num(n));
}

/** row gives a row of `cells`. */
function row(...cells: HTMLElement[]): HTMLTableRowElement {
  const tr = el("tr");
  tr.append(...cells);
  return tr;
}

/**
 * grouped gives a bars or pie chart's headers and rows: the value's column
 * and what `plot` measures, the rows or the column it sums, and a pie's
 * share column; a row per value sent, the largest first; one row for the
 * values a tally sent none of, counted, with their rows or sum and those of
 * the values past the ones a tally keeps apart; and a line that says so where
 * there are such values. A share is of the pie's whole, its slices': a value
 * at or below zero has none, and the values sent none of have Other's share
 * of them, or none where the pie draws no Other.
 */
export function grouped(
  plot: Extract<Plot, { t: "bars" | "pie" }>,
  groups: Groups,
): [HTMLElement[], HTMLElement[]] {
  const { by, sum } = plot;
  const measure = (g: Measured): number => (sum === undefined ? g.rows : g.sum);
  const heads = [
    header(columnLabel(by.header, by.col), true),
    sum === undefined
      ? header(m.chart_table_rows(), false, true)
      : header(columnLabel(sum.header, sum.col), true, true),
  ];
  const drawn = plot.t === "pie" ? slices(plot, groups) : [];
  const whole = wholeOf(drawn);
  if (plot.t === "pie") heads.push(header(m.chart_table_share(), false, true));
  // cells gives a row's cells: `n`, what it measures, and for a pie the share
  // of `inPie`, what the pie draws of it.
  const cells = (n: number, inPie: number): HTMLElement[] => {
    const share = inPie > 0 && whole > 0 ? percent(inPie / whole) : "";
    return plot.t === "pie" ? [digits(n), el("td", "num", share)] : [digits(n)];
  };
  const rows = groups.groups.map((g) => row(rowHead(g.value), ...cells(measure(g), measure(g))));
  const { others, below, rest } = groups;
  const left = others.values + below.values;
  if (left > 0) {
    const more = el("th", "", m.chart_bars_more({ count: num(left) }));
    more.scope = "row";
    const inOther =
      drawn.length > PIE_SLICES_AT_MOST && plot.t === "pie" ? unsent(plot, groups) : 0;
    rows.push(row(more, ...cells(measure(others) + measure(below) + measure(rest), inOther)));
  }
  if (rest.rows > 0) {
    const line = el("td", "chart-table-line", m.chart_bars_past({ count: num(DISTINCT_AT_MOST) }));
    line.colSpan = heads.length;
    rows.push(row(line));
  }
  return [heads, rows];
}

/**
 * points gives a scatter's headers and rows: its x and y columns, and a row
 * per point drawn, in the order sent.
 */
export function points(
  plot: Extract<Plot, { t: "scatter" }>,
  sample: Sample,
): [HTMLElement[], HTMLElement[]] {
  const heads = [plot.x, plot.y].map(({ header: name, col }) =>
    header(columnLabel(name, col), true, true),
  );
  return [heads, sample.x.map((x, i) => row(digits(x), digits(sample.y[i]!)))];
}

/**
 * stacked gives a stacked chart's headers and rows: the value's column, a
 * column per series sent in slot order, Other where a value has rows in it,
 * and the total; a row per value sent, the largest first; one for the values
 * a tally sent none of, with their total; and a line that says so where
 * there are values past those a tally keeps apart.
 */
export function stacked(plot: StackPlot, tally: StackTally): [HTMLElement[], HTMLElement[]] {
  const measure = (g: Measured): number => (plot.sum === undefined ? g.rows : g.sum);
  const other = tally.values.some((v) => v.other.rows > 0);
  const heads = [
    header(columnLabel(plot.by.header, plot.by.col), true),
    ...tally.series.map((s) =>
      s === "" ? header(m.chart_blank_value(), false, true) : header(s, true, true),
    ),
    ...(other ? [header(m.chart_pie_other(), false, true)] : []),
    header(m.chart_stack_total(), false, true),
  ];
  const rows = tally.values.map((v) =>
    row(
      rowHead(v.value),
      ...[...v.cells, ...(other ? [v.other] : []), v.total].map((c) => digits(measure(c))),
    ),
  );
  const { others, below, rest } = tally;
  const left = others.values + below.values;
  if (left > 0) {
    const more = rowNamed(m.chart_bars_more({ count: num(left) }));
    const gap = el("td");
    gap.colSpan = heads.length - 2;
    rows.push(row(more, gap, digits(measure(others) + measure(below) + measure(rest))));
  }
  if (rest.rows > 0) {
    const line = el("td", "chart-table-line", m.chart_bars_past({ count: num(DISTINCT_AT_MOST) }));
    line.colSpan = heads.length;
    rows.push(row(line));
  }
  return [heads, rows];
}

/** rowNamed gives a row's header of the app's words `text`. */
function rowNamed(text: string): HTMLTableCellElement {
  const th = el("th", "", text);
  th.scope = "row";
  return th;
}

/**
 * timed gives an over-time chart's headers and rows: the size it draws, rows,
 * and the column it sums; a row per period of `level` sent, earliest first,
 * empty ones too; one for the rows with no date, where there are any; and a
 * line of the summed column's cells it could not add.
 */
export function timed(
  { sum }: TimePlot,
  tally: TimeTally,
  level: TimeLevel,
): [HTMLElement[], HTMLElement[]] {
  const heads = [header(PER_WORDS[level.per](), false), header(m.chart_table_rows(), false, true)];
  if (sum !== undefined) heads.push(header(columnLabel(sum.header, sum.col), true, true));
  const cells = (rows: number, summed: number): HTMLElement[] =>
    sum === undefined ? [digits(rows)] : [digits(rows), digits(summed)];
  const rows = level.rows.map((n, i) =>
    row(rowNamed(label(level.per, level.from + i, true)), ...cells(n, level.sum[i] ?? 0)),
  );
  const { undated } = tally;
  if (undated.rows > 0)
    rows.push(row(rowNamed(m.chart_table_undated()), ...cells(undated.rows, undated.sum)));
  return [heads, [...rows, ...leftOut(tally, heads.length)]];
}

/**
 * weekly gives a week heatmap's heads and rows: a row per hour of the week,
 * Sunday 00:00 first, empty ones too, under its day and hour, or per day in a
 * grid of days, with its rows and its sum where the plot sums; one for the
 * rows with no date, where there are any; and a line of the cells left out.
 */
export function weekly({ sum }: WeekPlot, tally: WeekTally): [HTMLElement[], HTMLElement[]] {
  const { across, cells: slots } = slotsOf(tally);
  const named = across > 1 ? [PER_WORDS.day(), PER_WORDS.hour()] : [PER_WORDS.day()];
  const heads = named.map((word) => header(word, false));
  heads.push(header(m.chart_table_rows(), false, true));
  if (sum !== undefined) heads.push(header(columnLabel(sum.header, sum.col), true, true));
  const cells = (rows: number, summed: number): HTMLElement[] =>
    sum === undefined ? [digits(rows)] : [digits(rows), digits(summed)];
  const rows = slots.map(({ rows, sum: summed }, i) => {
    const day = rowNamed(dayName(Math.floor(i / across), "long"));
    const hour = across > 1 ? [rowNamed(clockName(i % across))] : [];
    return row(day, ...hour, ...cells(rows, summed));
  });
  const { undated } = tally;
  if (undated.rows > 0) {
    const none = rowNamed(m.chart_table_undated());
    none.colSpan = named.length;
    rows.push(row(none, ...cells(undated.rows, undated.sum)));
  }
  return [heads, [...rows, ...leftOut(tally, heads.length)]];
}

/**
 * heated gives a heatmap's heads and rows: a row per value sent and period of
 * `level`, empty ones too, with its rows and its sum where the plot sums; a
 * row per value of its rows with no date; and a line of the values not sent
 * and the cells left out.
 */
export function heated(
  plot: HeatPlot,
  tally: HeatTally,
  level: SplitLevel,
): [HTMLElement[], HTMLElement[]] {
  const { by, sum } = plot;
  const heads = [
    header(columnLabel(by.header, by.col), true),
    header(PER_WORDS[level.per](), false),
  ];
  heads.push(header(m.chart_table_rows(), false, true));
  if (sum !== undefined) heads.push(header(columnLabel(sum.header, sum.col), true, true));
  const cells = (rows: number, summed: number): HTMLElement[] =>
    sum === undefined ? [digits(rows)] : [digits(rows), digits(summed)];
  const rows = tally.values.flatMap(({ value }, i) =>
    level.rows[i]!.map((n, p) =>
      row(
        rowHead(value),
        rowNamed(label(level.per, level.from + p, true)),
        ...cells(n, level.sum[i]?.[p] ?? 0),
      ),
    ),
  );
  for (const { value, undated } of tally.values.filter((v) => v.undated.rows > 0)) {
    rows.push(
      row(rowHead(value), rowNamed(m.chart_table_undated()), ...cells(undated.rows, undated.sum)),
    );
  }
  const { others } = tally;
  if (others.values > 0) {
    const more = el(
      "td",
      "chart-table-line",
      `${m.chart_bars_more({ count: num(others.values) })} · ${m.rows_count({ count: others.rows })}`,
    );
    more.colSpan = heads.length;
    rows.push(row(more));
  }
  return [heads, [...rows, ...leftOut(tally, heads.length)]];
}

/** leftOut gives a line across `span` columns of the cells `tally` left out, or none. */
function leftOut(
  tally: TimeTally | WeekTally | HeatTally | SpreadTally | BoxTally | DotsTally | SlopeTally,
  span: number,
): HTMLElement[] {
  const left = [blank(tally), notNumbers(tally)].filter((part) => part !== "").join(SEP);
  if (left === "") return [];
  const line = el("td", "chart-table-line", left);
  line.colSpan = span;
  return [row(line)];
}

/**
 * dotted gives a dot plot's heads and rows: each value under its column `by`,
 * what its dot stands at, its numbers of a mean, and its rows of a mean or a
 * sum; then the values the tally sent none of, and the cells left out.
 */
export function dotted(plot: DotsPlot, tally: DotsTally): [HTMLElement[], HTMLElement[]] {
  const { by, of } = plot;
  const meant = tally.t === "mean";
  const word = (text: string) => header(text, false, true);
  const measure =
    of === undefined
      ? []
      : meant
        ? [word(m.chart_box_mean()), word(m.chart_table_numbers())]
        : [header(columnLabel(of.header, of.col), true, true)];
  const heads = [
    header(columnLabel(by.header, by.col), true),
    ...measure,
    word(m.chart_table_rows()),
  ];
  const sizes = measuresOf(plot, tally);
  const lines = tally.groups.map((g, i) => {
    const size = sizes[i];
    const at = size === undefined ? el("td", "num chart-blank", m.chart_dots_none()) : digits(size);
    const counts = [...(tally.t === "mean" ? [tally.groups[i]!.numbers] : []), g.rows];
    return row(rowHead(g.value), ...(of === undefined ? [at] : [at, ...counts.map(digits)]));
  });
  const { others, below, rest } = tally;
  const left = others.values + below.values;
  if (left > 0) {
    const more = el("th", "", m.chart_bars_more({ count: num(left) }));
    more.scope = "row";
    const sum = digits(others.sum + below.sum);
    const between = of === undefined ? [] : meant ? [el("td", "num"), el("td", "num")] : [sum];
    lines.push(row(more, ...between, digits(others.rows + below.rows)));
  }
  if (rest.rows > 0) {
    const line = el("td", "chart-table-line", m.chart_bars_past({ count: num(DISTINCT_AT_MOST) }));
    line.colSpan = heads.length;
    lines.push(row(line));
  }
  return [heads, [...lines, ...leftOut(tally, heads.length)]];
}

/**
 * sloping gives a slope chart's heads and rows: each value under its column
 * `by`, its two ends under their states, and its change and change as a
 * share where both ends have a number; then the values the tally sent none
 * of, and the cells left out.
 */
export function sloping(plot: SlopePlot, tally: SlopeTally): [HTMLElement[], HTMLElement[]] {
  const heads = [
    header(columnLabel(plot.by.header, plot.by.col), true),
    ...[plot.from, plot.to].map((state) => header(state, true, true)),
    ...[m.chart_table_change(), m.chart_table_share()].map((w) => header(w, false, true)),
  ];
  const at = (end?: number) =>
    end === undefined ? el("td", "num chart-blank", m.chart_slope_none()) : digits(end);
  const lines = endsOf(plot, tally).map(({ label, ends: [from, to] }) => {
    const change = from === undefined || to === undefined ? undefined : to - from;
    // A change is a share of a From end other than 0.
    const share =
      change === undefined || from === 0 || from === undefined
        ? ""
        : percent(change / Math.abs(from));
    const changed = change === undefined ? el("td", "num") : digits(change);
    return row(rowHead(label), at(from), at(to), changed, el("td", "num", share));
  });
  if (tally.others.values > 0) {
    const more = el("th", "", m.chart_bars_more({ count: num(tally.others.values) }));
    more.scope = "row";
    const rows = el("td", "", m.rows_count({ count: tally.others.rows }));
    rows.colSpan = heads.length - 1;
    lines.push(row(more, rows));
  }
  return [heads, [...lines, ...leftOut(tally, heads.length)]];
}

/** The heads of a box plot's numbers, after its rows'. */
const BOXED_HEADS = [
  m.chart_table_rows,
  m.chart_table_least,
  m.chart_table_hinge_low,
  m.chart_table_median,
  m.chart_table_hinge_high,
  m.chart_table_most,
  m.chart_box_mean,
  m.chart_table_past,
];

/**
 * boxed gives a box plot's heads and rows: each row under column `by`, its
 * numbers, R's five, mean and rows past its whiskers, then what `tally` left out.
 */
export function boxed(
  rows: readonly Boxed[],
  by: ChartColumn,
  tally: BoxTally,
): [HTMLElement[], HTMLElement[]] {
  const heads = [
    header(columnLabel(by.header, by.col), true),
    ...BOXED_HEADS.map((w) => header(w(), false, true)),
  ];
  const lines = rows.map(({ label, box, numbers }) => {
    const past = box.below.rows + box.above.rows;
    return row(rowHead(label), ...[numbers, ...box.five.map(middle), box.mean, past].map(digits));
  });
  return [heads, [...lines, ...leftOut(tally, heads.length)]];
}

/**
 * binned gives a histogram's heads and rows: each bin of `level` named by its
 * edges, with its rows and their share, then the rows under and over every
 * bin sent and the cells left out, so every row of the file is counted.
 */
export function binned(
  of: ChartColumn,
  tally: SpreadTally,
  level: Level,
): [HTMLElement[], HTMLElement[]] {
  const heads = [
    header(columnLabel(of.header, of.col), true),
    header(m.chart_table_rows(), false, true),
    header(m.chart_table_share(), false, true),
  ];
  const cells = (n: number) => [digits(n), el("td", "num", percent(n / tally.numbers))];
  const edge = (i: number) => edgeWords(level, i);
  const bin = (i: number) => m.chart_bin({ from: edge(i), to: edge(i + 1) });
  const rows = level.rows.map((n, i) => row(rowNamed(bin(i)), ...cells(n)));
  const count = level.rows.length;
  if (level.below > 0) {
    rows.unshift(row(rowNamed(m.chart_table_under({ edge: edge(0) })), ...cells(level.below)));
  }
  if (level.above > 0) {
    rows.push(row(rowNamed(m.chart_table_over({ edge: edge(count) })), ...cells(level.above)));
  }
  return [heads, [...rows, ...leftOut(tally, heads.length)]];
}

/**
 * tableOf gives a tally as its kind's `heads` and `rows`, as a table under a
 * caption of `called`, what the head calls the chart, in the window's
 * scroller.
 */
export function tableOf([heads, rows]: [HTMLElement[], HTMLElement[]], called: Node): HTMLElement {
  const box = el("div", "chart-table chart-scrolls themed-bar");
  const made = el("table");
  const caption = el("caption");
  caption.append(called);
  const thead = el("thead");
  thead.append(row(...heads));
  const tbody = el("tbody");
  tbody.append(...rows);
  made.append(caption, thead, tbody);
  box.append(made);
  return box;
}
