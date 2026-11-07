/**
 * @fileoverview The chart form: picks the column of the active source whose
 * values a chart's bars count the rows of. The engine keeps the chart, and a
 * refusal is shown in the form, which stays open on what was chosen.
 */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import { clamp } from "@renderer/grid/metrics";
import { columnLabel } from "@renderer/grid/rows";
import { PopForm, field } from "@renderer/shell/form";
import type { MenuPlace } from "@renderer/shell/menu";
import { el, message, option } from "@renderer/shell/util";

/** A source the form charts, as a tab has it: its id, its name and its columns' headers. */
export interface ChartSource {
  id: string;
  name: string;
  band: { columns: readonly { header: string }[] };
}

/** What the form asks of the shell. */
export interface ChartAsks {
  /** Inserts a chart of `plot` over `source`. Throws with a message when refused. */
  insert(source: ChartSource, plot: Plot): Promise<void>;
  /** Called when the form closes. */
  closed(): void;
}

export class ChartForm {
  private readonly form: PopForm;
  private readonly by = el("select");

  constructor(
    place: MenuPlace,
    private readonly source: ChartSource,
    /** The column selected in the grid, which the bars count by. */
    selected: number,
    private readonly asks: ChartAsks,
  ) {
    const title = m.chart_form_title_source({ source: source.name });
    this.form = new PopForm("chart-form", m.chart_form_title(), title, m.action_insert(), {
      submit: () => void this.insert(),
      // Enter on any field inserts, so the form makes a chart in one key.
      enters: (target) => !(target instanceof HTMLButtonElement),
      closed: () => asks.closed(),
    });

    for (const [i, c] of source.band.columns.entries()) {
      // A blank header is labelled by its position, as in the grid.
      const made = option(columnLabel(c.header, i), String(i));
      made.className = "from-file";
      this.by.append(made);
    }
    this.by.value = String(clamp(selected, source.band.columns.length - 1));
    this.form.open([field(m.chart_form_by(), this.by)], place);
    this.by.focus();
  }

  close(): void {
    this.form.close();
  }

  /** plot gives what the chart draws: bars of the rows per value of `by`. */
  private plot(): Plot {
    const col = Number(this.by.value);
    return { t: "bars", by: { col, header: this.source.band.columns[col]?.header ?? "" } };
  }

  /** insert sends the chart, unless one is in flight, and closes once the engine keeps it. */
  private async insert(): Promise<void> {
    if (this.form.submit.disabled) return;
    this.form.submit.disabled = true;
    try {
      await this.asks.insert(this.source, this.plot());
      this.close();
    } catch (err) {
      this.form.say(message(err), true);
      this.by.focus();
    } finally {
      this.form.submit.disabled = false;
    }
  }
}
