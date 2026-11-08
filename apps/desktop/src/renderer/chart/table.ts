/**
 * @fileoverview A chart's table: every value its tally sent with what it
 * measures, the largest first. It is the text alternative to the drawing: it
 * gives the exact numbers, a finger scrolls it, a person selects from it, and
 * a screen reader walks it as a table, under a caption that says what the
 * chart is called, its headers naming the columns.
 *
 * It is HTML chart.css lays out as the window's scroller. A value is the
 * file's text, set as text alone, and a number is in the app's language.
 */

import type { Plot } from "@document";
import type { Group, Groups, GroupsTally, SampleTally } from "@engine";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";

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
 * and what `plot` measures, the rows or the column it sums, then a row per
 * value sent, the largest first.
 */
function grouped(
  plot: Exclude<Plot, { t: "scatter" }>,
  groups: Groups,
): [HTMLElement[], HTMLElement[]] {
  const { by, sum } = plot;
  const measure = (g: Group): number => (sum === undefined ? g.rows : g.sum);
  const heads = [
    header(columnLabel(by.header, by.col), true),
    sum === undefined
      ? header(m.chart_table_rows(), false)
      : header(columnLabel(sum.header, sum.col), true),
  ];
  return [heads, groups.groups.map((g) => row(rowHead(g.value), digits(measure(g))))];
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
