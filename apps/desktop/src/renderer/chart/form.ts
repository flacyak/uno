/**
 * @fileoverview The chart form: picks the source, the kind of chart, the
 * column whose values its bars or pie count the rows of, or sum a number column
 * over, or the two number columns a scatter sets against each other, and its
 * title. It opens on the active source, and another source keeps each column it
 * has a header for.
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

/** A source the form charts, as a tab has it: its id, its name, its columns,
 * and whether its file is missing. */
export interface ChartSource {
  id: string;
  name: string;
  band: { columns: ReadonlyArray<Pick<ColumnInfo, "header" | "kind" | "flagged">> };
  missing: boolean;
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
  private readonly from = select("source");
  private readonly kind = select("kind");
  private readonly by = select("by");
  /** The number column bars or a pie sum, or "" for none, which counts the rows. */
  private readonly sum = select("sum");
  private readonly x = select("x");
  private readonly y = select("y");
  /** The fields bars and a pie ask for, and those a scatter asks for. */
  private readonly grouped = [
    field(m.chart_form_by(), this.by),
    field(m.chart_form_sum(), this.sum),
  ];
  private readonly paired = [field(m.chart_form_x(), this.x), field(m.chart_form_y(), this.y)];
  private readonly title = el("input");
  /** The source chosen, whose columns the selects offer. */
  private source: ChartSource;

  constructor(
    place: MenuPlace,
    /** The workspace's sources, in the order of their tabs. */
    private readonly sources: readonly ChartSource[],
    /** The active source, which the form opens on. */
    active: ChartSource,
    /** The column selected in the grid, which bars or a pie count by. */
    selected: number,
    private readonly asks: ChartAsks,
  ) {
    this.source = active;
    const heading = m.chart_form_title_source({ source: active.name });
    this.form = new PopForm("chart-form", m.chart_form_title(), heading, m.action_insert(), {
      submit: () => void this.insert(),
      // Enter on any field inserts, so the form makes a chart in one key.
      enters: (target) => !(target instanceof HTMLButtonElement),
      closed: () => asks.closed(),
    });

    for (const [i, s] of sources.entries()) {
      const made = this.from.appendChild(option(s.name, String(i)));
      made.className = "from-file";
      // A source whose file is missing has no rows to chart.
      made.disabled = s.missing;
    }
    this.from.value = String(sources.indexOf(active));
    this.from.addEventListener("change", () => this.choose());
    this.kind.append(...KINDS.map(([t, words]) => option(words(), t)));
    this.kind.addEventListener("change", () => this.ask());

    this.offer(selected);
    for (const column of [this.by, this.sum, this.x, this.y]) {
      column.addEventListener("change", () => this.name());
    }

    this.title.type = "text";
    this.title.maxLength = TITLE_AT_MOST;
    this.title.autocomplete = "off";

    const fields = [
      field(m.chart_form_source(), this.from),
      field(m.chart_form_kind(), this.kind),
      ...this.grouped,
      ...this.paired,
      field(m.chart_form_title_field(), this.title),
    ];
    this.form.open(fields, place);
    this.form.say(m.chart_form_hint(), false);
    this.by.focus();
  }

  close(): void {
    this.form.close();
  }

  /** choose offers the columns of the source chosen, keeping each column
   * chosen whose header it has, and names it in the title line. */
  private choose(): void {
    const header = (select: HTMLSelectElement): string | undefined =>
      select.value === "" ? undefined : this.source.band.columns[Number(select.value)]?.header;
    const [by, sum] = [header(this.by), header(this.sum)];
    this.source = this.sources[Number(this.from.value)] ?? this.source;
    this.form.heading.textContent = m.chart_form_title_source({ source: this.source.name });
    const at = this.source.band.columns.findIndex((c) => c.header === by);
    this.offer(Math.max(0, at), sum);
  }

  /** offer fills the selects with the source's columns, choosing `by` and the
   * number column whose header is `sum`, if any. X is the first number
   * column, and Y another. */
  private offer(by: number, sum?: string): void {
    const numbers: number[] = [];
    this.by.replaceChildren();
    this.sum.replaceChildren(option(m.chart_form_sum_none(), ""));
    this.x.replaceChildren();
    this.y.replaceChildren();
    for (const [i, c] of this.source.band.columns.entries()) {
      this.by.append(fromFile(c.header, i));
      // Cells that do not read as numbers are left out of a sum or a scatter and counted.
      if (c.kind !== "num" && !c.flagged) continue;
      numbers.push(i);
      this.sum.append(fromFile(c.header, i, c.header === sum));
      this.x.append(fromFile(c.header, i));
      this.y.append(fromFile(c.header, i));
    }
    this.by.value = String(clamp(by, this.source.band.columns.length - 1));
    const x = numbers[0];
    this.x.value = String(x ?? "");
    this.y.value = String(numbers.find((i) => i !== x) ?? x ?? "");
    this.ask();
  }

  /** ask shows the fields the kind chosen asks for, and the title it makes. */
  private ask(): void {
    const scatter = this.kind.value === "scatter";
    for (const line of this.grouped) line.hidden = scatter;
    for (const line of this.paired) line.hidden = !scatter;
    this.name();
  }

  /** plot gives what the chart draws: bars or a pie of the rows, or of the sum,
   * per value of `by`, or a scatter of `y` against `x`. */
  private plot(): Plot {
    if (this.kind.value === "scatter") {
      return { t: "scatter", x: this.column(this.x.value), y: this.column(this.y.value) };
    }
    const t = this.kind.value === "pie" ? "pie" : "bars";
    const by = this.column(this.by.value);
    return this.sum.value === "" ? { t, by } : { t, by, sum: this.column(this.sum.value) };
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
      (this.kind.value === "scatter" ? this.x : this.by).focus();
    } finally {
      this.form.submit.disabled = false;
    }
  }
}

/** fromFile is the option of column `col`, labelled as the file names it. */
function fromFile(header: string, col: number, selected = false): HTMLOptionElement {
  // A blank header is labelled by its position, as in the grid.
  const made = option(columnLabel(header, col), String(col));
  made.className = "from-file";
  made.selected = selected;
  return made;
}

/** select makes a select named for what it sets. */
function select(name: string): HTMLSelectElement {
  const made = el("select");
  made.name = name;
  return made;
}
