/**
 * @fileoverview A chart's table: every value its tally sent with what it
 * measures, the largest first, and the values left out counted after them.
 * It is the text alternative to the drawing: it
 * gives the exact numbers, a finger scrolls it, a person selects from it, and
 * a screen reader walks it as a table, under a caption that says what the
 * chart is called, its headers naming the columns.
 *
 * It is HTML chart.css lays out as the window's scroller. A value is the
 * file's text, set as text alone, and a number is in the app's language.
 */

import type { Plot } from "@document";
import { DISTINCT_AT_MOST } from "@engine";
import type { Groups, GroupsTally, SampleTally } from "@engine";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { num, percent } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { PIE_SLICES_AT_MOST, slices, unsent, wholeOf } from "./pie.ts";

/** What a tally measures of a value, or of the values it leaves out: their rows and their sum. */
type Measured = Pick<Groups["rest"], "rows" | "sum">;

/** words writes `text` in `cell`: the file's, in a bdi marked as the file's, or the app's. */
function words(cell: HTMLTableCellElement, text: string, fromFile: boolean): HTMLTableCellElement {
  if (fromFile) cell.append(el("bdi", "from-file", text));
  else cell.textContent = text;
  return cell;
}

/** header gives a column's header of `text`, the file's or the app's. */
function header(text: string, fromFile: boolean): HTMLTableCellElement {
  const th = el("th");
  th.scope = "col";
  return words(th, text, fromFile);
}

/** rowHead gives a row's header of `value`: the file's text, or the app's word for a blank cell. */
function rowHead(value: string): HTMLTableCellElement {
  const th = el("th");
  th.scope = "row";
  return value === "" ? words(th, m.chart_blank_value(), false) : words(th, value, true);
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
function grouped(
  plot: Exclude<Plot, { t: "scatter" }>,
  groups: Groups,
): [HTMLElement[], HTMLElement[]] {
  const { by, sum } = plot;
  const measure = (g: Measured): number => (sum === undefined ? g.rows : g.sum);
  const heads = [
    header(columnLabel(by.header, by.col), true),
    sum === undefined
      ? header(m.chart_table_rows(), false)
      : header(columnLabel(sum.header, sum.col), true),
  ];
  const drawn = plot.t === "pie" ? slices(plot, groups) : [];
  const whole = wholeOf(drawn);
  if (plot.t === "pie") heads.push(header(m.chart_table_share(), false));
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
 * table gives `tally` as `plot` reads it, as a table under a caption of
 * `called`, what the head calls the chart, in the window's scroller.
 */
export function table(plot: Plot, tally: GroupsTally | SampleTally, called: Node): HTMLElement {
  const box = el("div", "chart-table chart-scrolls");
  const made = el("table");
  const caption = el("caption");
  caption.append(called);
  const [heads, rows] =
    plot.t !== "scatter" && tally.t === "groups" ? grouped(plot, tally) : [[], []];
  const thead = el("thead");
  thead.append(row(...heads));
  const tbody = el("tbody");
  tbody.append(...rows);
  made.append(caption, thead, tbody);
  box.append(made);
  return box;
}
