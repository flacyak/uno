/**
 * @fileoverview A chart's window: the dialogs' box, with a head that says what
 * the chart shows. The layer stands it in the room and says which chart it shows.
 */

import type { Chart, ChartColumn, Plot } from "@document";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { el } from "@renderer/shell/util";

/** madeTitle gives the title a plot makes, in the app's language. */
export function madeTitle(plot: Plot): string {
  const named = ({ header, col }: ChartColumn): string => columnLabel(header, col);
  if (plot.t === "scatter") return m.chart_title_against({ x: named(plot.x), y: named(plot.y) });
  const by = named(plot.by);
  const sum = plot.sum === undefined ? undefined : named(plot.sum);
  if (plot.t === "bars") {
    return sum === undefined ? m.chart_title_rows({ by }) : m.chart_title_sum({ by, sum });
  }
  return sum === undefined
    ? m.chart_title_share_of_rows({ by })
    : m.chart_title_share_of_sum({ by, sum });
}

export class ChartWindow {
  /** The whole window, which the layer stands in the room. */
  readonly box = el("div", "chart");
  private readonly title = el("span", "chart-title");

  constructor() {
    const head = el("div", "col-head chart-head");
    head.append(this.title);
    this.box.append(head);
  }

  /** show writes what `chart` says in the head. */
  show(chart: Chart): void {
    this.title.replaceChildren(el("bdi", "", madeTitle(chart.plot)));
    this.title.title = this.title.textContent;
  }
}
