/**
 * @fileoverview The chart form: picks the source, the kind of chart, the
 * column whose values its bars or pie count the rows of, or sum a number column
 * over, or the two number columns a scatter sets against each other, and its
 * title. It opens on the active source, and another source keeps each column it
 * has a header for. Opened on a chart, it shows what the chart shows, and its
 * primary button is Apply.
 *
 * An empty title shows the one the chart makes, which follows the language.
 * Refresh sets how often the chart's source is checked for newer data.
 * The engine keeps the chart, and a refusal is shown in the form, which stays
 * open on what was chosen.
 */

import "./form.css";

import { BY_HAND, REFRESH_MINUTES_AT_MOST, TITLE_AT_MOST } from "@document";
import type { Chart, ChartColumn, Plot } from "@document";
import { placeOf } from "@engine";
import type { ColumnInfo } from "@engine";
import { m } from "@paraglide/messages";
import { clamp } from "@renderer/grid/metrics";
import { columnLabel } from "@renderer/grid/rows";
import { num } from "@renderer/locale";
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
   * it makes, or changes the chart the form opened on to it. Throws with a
   * message when refused. Its source is checked every `refresh` minutes. */
  send(source: ChartSource, plot: Plot, title: string, refresh: number): Promise<void>;
  /** Called when the form closes. */
  closed(): void;
}

/** What the form opens on: the column selected in the grid, to insert a chart
 * of it, or a chart over the active source, to change it. */
export type Opening =
  | { t: "insert"; col: number }
  | { t: "change"; chart: Pick<Chart, "plot" | "title"> };

/** The kinds of chart, in the order the form offers them. */
const KINDS: ReadonlyArray<readonly [Plot["t"], () => string]> = [
  ["bars", m.chart_kind_bars],
  ["pie", m.chart_kind_pie],
  ["scatter", m.chart_kind_scatter],
];

/** The minutes in an hour and in a day. */
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

/** The schedules under an hour the form offers, in minutes between checks. */
const EVERY_FEW_MINUTES = [5, 15, 30];

/** The schedules the form offers, in minutes between checks, and their words. */
const SCHEDULES: ReadonlyArray<readonly [number, () => string]> = [
  [BY_HAND, m.chart_refresh_by_hand],
  ...EVERY_FEW_MINUTES.map(
    (n) => [n, () => m.chart_refresh_every_minutes({ count: num(n) })] as const,
  ),
  [HOUR_MINUTES, m.chart_refresh_every_hour],
  [DAY_MINUTES, m.chart_refresh_every_day],
];

/** The Refresh option that shows a number and a unit of one's own. */
const EVERY = "every";

/** The most Every… counts, which its number's digits hold. */
const EVERY_AT_MOST = 999;

/** A minute, in minutes. */
const ONE_MINUTE = 1;

/** What Every…'s number holds when it is a whole number as written: digits alone. */
const DIGITS = /^\d+$/;

/** The units Every… counts in, in minutes, and their words. */
const UNITS: ReadonlyArray<readonly [number, () => string]> = [
  [ONE_MINUTE, m.chart_refresh_unit_minutes],
  [HOUR_MINUTES, m.chart_refresh_unit_hours],
];

/** How many number columns a scatter needs: one across it and one up it. */
const SCATTER_COLUMNS = 2;

export class ChartForm {
  private readonly form: PopForm;
  private readonly from = select("source");
  private readonly kind = select("kind");
  private readonly by = select("by");
  /** The number column bars or a pie sum, or "" for none, which counts the rows. */
  private readonly sum = select("sum");
  /** The number column across a scatter, the selected one where it holds numbers. */
  private readonly x = select("x");
  /** The number column up a scatter, one other than X. */
  private readonly y = select("y");
  /** The fields bars and a pie ask for, and those a scatter asks for. */
  private readonly grouped = [
    field(m.chart_form_by(), this.by),
    field(m.chart_form_sum(), this.sum),
  ];
  private readonly paired = [field(m.chart_form_x(), this.x), field(m.chart_form_y(), this.y)];
  private readonly title = el("input");
  /** The minutes between checks of the source, or By hand. */
  private readonly refresh = select("refresh");
  /** Every…'s number, of minutes or hours as its unit says. */
  private readonly count = el("input", "count");
  private readonly unit = select("unit");
  /** The source chosen, whose columns the selects offer. */
  private source: ChartSource;

  constructor(
    place: MenuPlace,
    /** The workspace's sources, in the order of their tabs. */
    private readonly sources: readonly ChartSource[],
    /** The active source, which the form opens on. */
    active: ChartSource,
    /** What the form opens on. */
    private readonly opening: Opening,
    private readonly asks: ChartAsks,
  ) {
    this.source = active;
    const changes = opening.t === "change";
    const label = changes ? m.chart_edit() : m.chart_form_title();
    const heading = changes
      ? m.chart_form_title_chart({ title: opening.chart.title || madeTitle(opening.chart.plot) })
      : m.chart_form_title_source({ source: active.name });
    const primary = changes ? m.action_apply() : m.action_insert();
    this.form = new PopForm("chart-form", label, heading, primary, {
      submit: () => void this.send(),
      // Enter on any field sends what the form holds, so a chart is made or changed in one key.
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

    if (opening.t === "insert") this.offer(opening.col);
    else this.opensOn(opening.chart.plot);
    for (const column of [this.by, this.sum, this.x, this.y]) {
      column.addEventListener("change", () => this.name());
    }

    this.title.type = "text";
    this.title.maxLength = TITLE_AT_MOST;
    this.title.autocomplete = "off";
    if (opening.t === "change") this.title.value = opening.chart.title;
    this.refresh.append(...SCHEDULES.map(([minutes, words]) => option(words(), String(minutes))));
    this.refresh.append(option(m.chart_refresh_every_other(), EVERY));
    this.refresh.addEventListener("change", () => this.reveal());
    this.count.inputMode = "numeric";
    this.count.maxLength = String(EVERY_AT_MOST).length;
    this.count.autocomplete = "off";
    this.unit.append(...UNITS.map(([minutes, words]) => option(words(), String(minutes))));
    this.reveal();
    const schedule = el("span", "schedule");
    schedule.append(this.refresh, this.count, this.unit);

    const fields = [
      field(m.chart_form_source(), this.from),
      field(m.chart_form_kind(), this.kind),
      ...this.grouped,
      ...this.paired,
      field(m.chart_form_title_field(), this.title),
      ...(changes ? [] : [field(m.chart_form_refresh(), schedule)]),
    ];
    this.form.open(fields, place);
    this.form.say(changes ? m.chart_form_hint_change() : m.chart_form_hint(), false);
    this.first().focus();
  }

  close(): void {
    this.form.close();
  }

  /** choose offers the columns of the source chosen, keeping each column
   * chosen whose header it has, and names it in an insert's title line. */
  private choose(): void {
    const chosen = (select: HTMLSelectElement): ChartColumn | undefined =>
      select.value === "" ? undefined : this.column(select.value);
    const [by, ...kept] = [this.by, this.sum, this.x, this.y].map(chosen);
    this.source = this.sources[Number(this.from.value)] ?? this.source;
    if (this.opening.t === "insert") {
      this.form.heading.textContent = m.chart_form_title_source({ source: this.source.name });
    }
    this.offer(this.at(by), kept);
  }

  /** opensOn chooses `plot`'s kind, and the source's columns it names. */
  private opensOn(plot: Plot): void {
    this.kind.value = plot.t;
    if (plot.t === "scatter") this.offer(this.at(plot.x), [undefined, plot.x, plot.y]);
    else this.offer(this.at(plot.by), [plot.sum]);
  }

  /** at gives where the source holds `column`, or else its first column. */
  private at(column: ChartColumn | undefined): number {
    return this.placed(column) ?? 0;
  }

  /** placed gives where the source holds `column`, found as a tally finds it. */
  private placed(column: ChartColumn | undefined): number | undefined {
    const headers = this.source.band.columns.map((c) => c.header);
    return column === undefined ? undefined : placeOf(column, headers);
  }

  /** first gives the column select the kind chosen asks for first. */
  private first(): HTMLSelectElement {
    return this.kind.value === "scatter" ? this.x : this.by;
  }

  /** offer fills the selects with the source's columns, choosing `by` and,
   * for Sum of, X and Y, where the source holds the number columns `kept`. X is
   * otherwise `by` where it holds numbers, or else the first number column, and
   * never Y's, and Y is otherwise one other than X. */
  private offer(by: number, kept: ReadonlyArray<ChartColumn | undefined> = []): void {
    const columns = this.source.band.columns;
    const numbers: number[] = [];
    this.by.replaceChildren();
    this.sum.replaceChildren(option(m.chart_form_sum_none(), ""));
    this.x.replaceChildren();
    this.y.replaceChildren();
    for (const [i, c] of columns.entries()) {
      this.by.append(fromFile(c.header, i));
      // Cells that do not read as numbers are left out of a sum or a scatter and counted.
      if (c.kind !== "num" && !c.flagged) continue;
      numbers.push(i);
      for (const offered of [this.sum, this.x, this.y]) offered.append(fromFile(c.header, i));
    }
    const held = (column?: ChartColumn): number | undefined => {
      const at = this.placed(column);
      return at !== undefined && numbers.includes(at) ? at : undefined;
    };
    const [sum, x, y] = kept.map(held);
    const xAt = x ?? [by, ...numbers].find((i) => numbers.includes(i) && i !== y) ?? y;
    const yAt = y ?? numbers.find((i) => i !== xAt) ?? xAt;
    this.by.value = String(clamp(by, columns.length - 1));
    this.sum.value = String(sum ?? "");
    this.x.value = String(xAt ?? "");
    this.y.value = String(yAt ?? "");

    const scatters = numbers.length >= SCATTER_COLUMNS;
    for (const made of this.kind.options) if (made.value === "scatter") made.disabled = !scatters;
    if (!scatters && this.kind.value === "scatter") this.kind.value = "bars";
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

  /** reveal shows Every…'s number and unit while it is chosen. */
  private reveal(): void {
    const preset = this.refresh.value !== EVERY;
    this.count.hidden = preset;
    this.unit.hidden = preset;
  }

  /** minutes gives the minutes between checks that Refresh holds, or undefined
   * for an Every… of no whole number, or of under a minute or over a week. */
  private minutes(): number | undefined {
    if (this.refresh.value !== EVERY) return Number(this.refresh.value);
    const minutes = Number(this.count.value) * Number(this.unit.value);
    const kept = DIGITS.test(this.count.value) && minutes >= ONE_MINUTE;
    return kept && minutes <= REFRESH_MINUTES_AT_MOST ? minutes : undefined;
  }

  /** send sends the chart, unless one is in flight or Every… holds no
   * schedule, and closes once the engine keeps it. */
  private async send(): Promise<void> {
    const minutes = this.minutes();
    if (minutes === undefined) {
      const most = REFRESH_MINUTES_AT_MOST / HOUR_MINUTES;
      this.form.say(m.chart_refresh_range({ least: num(ONE_MINUTE), most: num(most) }), true);
      this.count.focus();
      return;
    }
    if (this.form.submit.disabled) return;
    this.form.submit.disabled = true;
    try {
      await this.asks.send(this.source, this.plot(), this.title.value.trim(), minutes);
      this.close();
    } catch (err) {
      this.form.say(message(err), true);
      this.first().focus();
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
