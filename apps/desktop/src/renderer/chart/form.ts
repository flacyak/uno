/**
 * @fileoverview The chart form: picks the kind of chart, the column of the
 * active source whose values its bars count the rows of, or sum a number
 * column over, and its title. It makes bars, and shows the kinds to come.
 *
 * An empty title shows the one the chart makes, which follows the language.
 * The engine keeps the chart, and a refusal is shown in the form, which stays
 * open on what was chosen.
 */

import "./form.css";

import { TITLE_AT_MOST } from "@document";
import type { ChartColumn, Plot } from "@document";
import type { ColumnInfo } from "@engine";
import { m } from "@paraglide/messages";
import { clamp } from "@renderer/grid/metrics";
import { columnLabel } from "@renderer/grid/rows";
import { PopForm, field } from "@renderer/shell/form";
import type { MenuPlace } from "@renderer/shell/menu";
import { el, message, option } from "@renderer/shell/util";
import { madeTitle } from "./window.ts";

/** A source the form charts, as a tab has it: its id, its name and its columns. */
export interface ChartSource {
  id: string;
  name: string;
  band: { columns: ReadonlyArray<Pick<ColumnInfo, "header" | "kind" | "flagged">> };
}

/** What the form asks of the shell. */
export interface ChartAsks {
  /** Inserts a chart of `plot` over `source`, titled `title` or "" for the one
   * it makes. Throws with a message when refused. */
  insert(source: ChartSource, plot: Plot, title: string): Promise<void>;
  /** Called when the form closes. */
  closed(): void;
}

/** The kinds of chart, in the order the form offers them. */
const KINDS: ReadonlyArray<readonly [Plot["t"], () => string]> = [
  ["bars", m.chart_kind_bars],
  ["pie", m.chart_kind_pie],
  ["scatter", m.chart_kind_scatter],
];

export class ChartForm {
  private readonly form: PopForm;
  private readonly kind = select("kind");
  private readonly by = select("by");
  /** The number column the bars sum, or "" for none, which counts the rows. */
  private readonly sum = select("sum");
  private readonly title = el("input");

  constructor(
    place: MenuPlace,
    private readonly source: ChartSource,
    /** The column selected in the grid, which the bars count by. */
    selected: number,
    private readonly asks: ChartAsks,
  ) {
    const heading = m.chart_form_title_source({ source: source.name });
    this.form = new PopForm("chart-form", m.chart_form_title(), heading, m.action_insert(), {
      submit: () => void this.insert(),
      // Enter on any field inserts, so the form makes a chart in one key.
      enters: (target) => !(target instanceof HTMLButtonElement),
      closed: () => asks.closed(),
    });

    for (const [t, words] of KINDS) {
      const made = this.kind.appendChild(option(words(), t));
      // Only bars are made yet, so the other kinds cannot be chosen.
      made.disabled = t !== "bars";
    }

    this.offer(selected);
    this.by.addEventListener("change", () => this.name());
    this.sum.addEventListener("change", () => this.name());

    this.title.type = "text";
    this.title.maxLength = TITLE_AT_MOST;
    this.title.autocomplete = "off";

    const fields = [
      field(m.chart_form_kind(), this.kind),
      field(m.chart_form_by(), this.by),
      field(m.chart_form_sum(), this.sum),
      field(m.chart_form_title_field(), this.title),
    ];
    this.form.open(fields, place);
    this.by.focus();
  }

  close(): void {
    this.form.close();
  }

  /** offer fills the selects with the source's columns, choosing `by`. */
  private offer(by: number): void {
    this.by.replaceChildren();
    this.sum.replaceChildren(option(m.chart_form_sum_none(), ""));
    for (const [i, c] of this.source.band.columns.entries()) {
      this.by.append(fromFile(c.header, i));
      // Cells that do not read as numbers are left out of a sum and counted.
      if (c.kind === "num" || c.flagged) this.sum.append(fromFile(c.header, i));
    }
    this.by.value = String(clamp(by, this.source.band.columns.length - 1));
    this.name();
  }

  /** plot gives what the chart draws: bars of the rows, or of the sum, per value of `by`. */
  private plot(): Plot {
    const by = this.column(this.by.value);
    return this.sum.value === ""
      ? { t: "bars", by }
      : { t: "bars", by, sum: this.column(this.sum.value) };
  }

  /** column gives the source's column whose option has `value`, as a chart reads it. */
  private column(value: string): ChartColumn {
    const col = Number(value);
    return { col, header: this.source.band.columns[col]?.header ?? "" };
  }

  /** name shows the title the chart makes, which an empty title keeps. */
  private name(): void {
    this.title.placeholder = madeTitle(this.plot());
  }

  /** insert sends the chart, unless one is in flight, and closes once the engine keeps it. */
  private async insert(): Promise<void> {
    if (this.form.submit.disabled) return;
    this.form.submit.disabled = true;
    try {
      await this.asks.insert(this.source, this.plot(), this.title.value.trim());
      this.close();
    } catch (err) {
      this.form.say(message(err), true);
      this.by.focus();
    } finally {
      this.form.submit.disabled = false;
    }
  }
}

/** fromFile is the option of column `col`, labelled as the file names it. */
function fromFile(header: string, col: number): HTMLOptionElement {
  // A blank header is labelled by its position, as in the grid.
  const made = option(columnLabel(header, col), String(col));
  made.className = "from-file";
  return made;
}

/** select makes a select named for what it sets. */
function select(name: string): HTMLSelectElement {
  const made = el("select");
  made.name = name;
  return made;
}
