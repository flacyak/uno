/**
 * @fileoverview A chart's window: the dialogs' box, with a head that says what
 * the chart shows. The layer stands it in the room and says which chart it shows.
 */

import type { Chart, ChartColumn, Plot } from "@document";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { Words, el } from "@renderer/shell/util";

/** How many windows have been made, so each one's ids are its own. A chart's
 * id can be any name, and aria-labelledby reads a space as a second id. */
let made = 0;

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
  /** The words that stay whichever chart the window shows. */
  private readonly words = new Words();

  constructor() {
    this.title.id = `chart-${++made}-title`;

    const head = el("div", "col-head chart-head");
    head.append(this.title);

    this.box.setAttribute("role", "group");
    this.box.setAttribute("aria-labelledby", this.title.id);
    this.words.attr(this.box, "aria-roledescription", m.chart_role);
    this.box.append(head);
  }

  /** show writes what `chart` says in the head, after `source` if it has one. */
  show(chart: Chart, source: string | undefined): void {
    const title = el("bdi", "", chart.title === "" ? madeTitle(chart.plot) : chart.title);
    if (source === undefined) this.title.replaceChildren(title);
    else this.title.replaceChildren(el("bdi", "from-file", source), " · ", title);
    this.title.title = this.title.textContent;
    this.title.classList.toggle("from-file", chart.title !== "");
  }

  /** relabel writes the window's own words in the current language. */
  relabel(): void {
    this.words.write();
  }
}
