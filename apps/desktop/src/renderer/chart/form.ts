/**
 * @fileoverview The chart form: picks the source, the kind of chart, the
 * column whose values or dates its chart counts the rows of, or sums a number
 * column over, or the two number columns a scatter sets against each other,
 * and its title. It opens on the active source, and another keeps each column
 * it has a header for. Opened on a chart, it shows what the chart shows, and
 * its primary button is Apply.
 *
 * An empty title shows the one the chart makes, which follows the language.
 * Refresh sets how often the chart's source is checked for newer data.
 * The engine keeps the chart, and a refusal is shown in the form, which stays
 * open on what was chosen.
 */

import "./form.css";

import {
  BY_HAND,
  DAY_MINUTES,
  HOUR_MINUTES,
  REFRESH_MINUTES_AT_MOST,
  TITLE_AT_MOST,
} from "@document";
import type {
  Chart,
  ChartColumn,
  DotMeasure,
  HeatPlot,
  Plot,
  Reading,
  SlopePlot,
  TimePlot,
  WeekPlot,
} from "@document";
import type { Span } from "@tally";
import { civilFromDays, readDate } from "@date";
import type { Order, UnixUnit } from "@date";
import { placeOf } from "@engine";
import type { Band, ColumnInfo, Link, PartInfo } from "@engine";
import { m } from "@paraglide/messages";
import { clamp } from "@renderer/grid/metrics";
import { columnLabel } from "@renderer/grid/rows";
import { num } from "@renderer/locale";
import { PopForm, field } from "@renderer/shell/form";
import type { MenuPlace } from "@renderer/shell/menu";
import { getLocale } from "@paraglide/runtime";
import { el, message, option } from "@renderer/shell/util";
import { rereads } from "@renderer/workspace";
import type { Rereads } from "@renderer/workspace";
import { PER_WORDS, monthOf } from "./periods.ts";
import { commonest, stateOption, twoOf } from "./states.ts";
import { KindTiles, QUESTIONS } from "./tiles.ts";
import { madeTitle } from "./window.ts";
import { PER } from "@tally";

/** A source the form charts, as a tab has it: its id, its name, its columns,
 * whether its file is missing, and the file or files a refresh reads again. */
export interface ChartSource {
  id: string;
  name: string;
  band: Pick<Band, "raw" | "ready"> & {
    columns: ReadonlyArray<Pick<ColumnInfo, "header" | "kind" | "flagged" | "order" | "unit">>;
  };
  missing: boolean;
  link?: Pick<Link, "path">;
  parts?: readonly PartInfo[];
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
  | { t: "change"; chart: Pick<Chart, "plot" | "title" | "refresh">; on?: "refresh" };

/** The sizes Per offers, Automatic first, then finest first. */
const PERS: ReadonlyArray<readonly [TimePlot["per"], () => string]> = [
  ["auto", m.chart_per_auto],
  ...PER.map((per) => [per, PER_WORDS[per]] as const),
];

/** How many of a source's first rows the form reads a date column's cells from. */
const SAMPLE_ROWS = 200;

/** The language whose undecided dates read month first; every other reads day first. */
const MONTH_FIRST = "en-US";

/** The orders a date written year last reads in, and their words where no cell shows them. */
const ORDERS: ReadonlyArray<readonly [Order, () => string]> = [
  ["day", m.chart_order_day],
  ["month", m.chart_order_month],
];

/** What a Unix column's unit is called. */
const UNIT_WORDS: Readonly<Record<UnixUnit, () => string>> = {
  s: m.kind_unix_s,
  ms: m.kind_unix_ms,
};

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

/** What a scheduled check reads of each kind of source, or why it reads
 * nothing, in a note's two lines. */
const CHECKS: Record<Rereads, (named: { name: string }) => string> = {
  file: m.chart_refresh_does_file,
  object: m.chart_refresh_does_object,
  folder: m.chart_refresh_does_folder,
  carried: m.chart_refresh_note_carried,
  lost: m.chart_refresh_note_lost,
};

/** Why a check of a source with nothing to read again reads nothing, in full,
 * as the chart window's refresh button says it. */
const READS_NOTHING: Partial<Record<Rereads, (named: { name: string }) => string>> = {
  carried: m.chart_refresh_carried,
  lost: m.chart_refresh_lost,
};

/** How many number columns a scatter needs: one across it and one up it. */
const SCATTER_COLUMNS = 2;

export class ChartForm {
  private readonly form: PopForm;
  private readonly from = select("source");
  private readonly kind = new KindTiles(QUESTIONS);
  private readonly by = select("by");
  /** The number column bars or a pie sum, or "" for none, which counts the rows. */
  private readonly sum = select("sum");
  /** The column whose values split each bar into a stack, or "" for none, a bar per value. */
  private readonly split = select("split");
  /** The number column across a scatter, the selected one where it holds numbers. */
  private readonly x = select("x");
  /** The number column up a scatter, one other than X. */
  private readonly y = select("y");
  /** The date column an over-time chart counts or sums over, and the size of its periods. */
  private readonly at = select("at");
  private readonly per = select("per");
  /** The number column a histogram spreads, and the span the chart opened on draws, which it keeps. */
  private readonly of = select("of");
  private readonly spread = field(m.chart_form_of(), this.of);
  /** The column a box plot splits its numbers by, or "" for one box. */
  private readonly boxBy = select("box-by");
  private readonly boxed = field(m.chart_form_by(), this.boxBy);
  private readonly span: Span;
  /** The number column a dot plot is of, or "" for none, which counts the rows, and how it measures it. */
  private readonly dotsOf = select("dots-of");
  private readonly measure = select("measure");
  private readonly dotted = [
    field(m.chart_form_of(), this.dotsOf),
    field(m.chart_form_measure(), this.measure),
  ];
  /** The column whose values name a slope's states, and the two it draws, among its most common values. */
  private readonly between = select("between");
  private readonly stateFrom = select("from");
  private readonly stateTo = select("to");
  private readonly sloping = [
    field(m.chart_form_between(), this.between),
    field(m.chart_form_from(), this.stateFrom),
    field(m.chart_form_to(), this.stateTo),
  ];
  /** The states of the slope the form opened on, kept while their column stays. */
  private readonly states: SlopePlot | undefined;
  /** The values a person moved among the rows of the bars or dots the form opened on, kept while their column stays. */
  private readonly moved: { by: ChartColumn; order: string[] } | undefined;
  /** How the chart opened on reads its dates, which it keeps while its date column stays. */
  private readonly read: TimePlot | WeekPlot | HeatPlot | undefined;
  /** The fields an over-time chart asks for before Sum of, and those bars and a pie ask for. */
  /** How the date column's dates written year last read, where it writes such. */
  private readonly order = select("order");
  private readonly timed = [
    field(m.chart_form_at(), this.at),
    field(m.chart_form_order(), this.order),
    field(m.chart_form_per(), this.per),
  ];
  private readonly grouped = [
    field(m.chart_form_by(), this.by),
    field(m.chart_form_sum(), this.sum),
    field(m.chart_form_split(), this.split),
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
    const plotted = changes ? opening.chart.plot : undefined;
    const dated = plotted?.t === "time" || plotted?.t === "week" || plotted?.t === "heat";
    this.read = dated ? plotted : undefined;
    const was = opening.t === "change" ? opening.chart.plot : undefined;
    this.span = was?.t === "histogram" || was?.t === "box" ? was.span : "most";
    this.states = was?.t === "slope" ? was : undefined;
    const order = was?.t === "dots" ? was.order : undefined;
    this.moved = was?.t === "dots" && order !== undefined ? { by: was.by, order } : undefined;
    this.measure.append(
      option(m.chart_form_mean(), "mean"),
      option(m.chart_form_sum_word(), "sum"),
    );
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
    this.kind.box.addEventListener("change", () => this.ask());
    this.at.addEventListener("change", () => this.dated());
    this.by.addEventListener("change", () => this.ask());
    this.of.addEventListener("change", () => this.ask());
    this.dotsOf.addEventListener("change", () => this.ask());
    this.between.addEventListener("change", () => this.stated());
    this.stateFrom.addEventListener("change", () => this.ask());
    this.per.append(...PERS.map(([per, words]) => option(words(), per)));

    if (opening.t === "insert") this.inserts(opening.col);
    else this.opensOn(opening.chart.plot);
    for (const column of [
      this.at,
      this.order,
      this.per,
      this.by,
      this.sum,
      this.split,
      this.x,
      this.y,
      this.of,
      this.boxBy,
      this.dotsOf,
      this.measure,
      this.between,
      this.stateFrom,
      this.stateTo,
    ]) {
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
    this.every(opening.t === "change" ? opening.chart.refresh : BY_HAND);
    const schedule = el("span", "schedule");
    schedule.append(this.refresh, this.count, this.unit);

    const fields = [
      field(m.chart_form_source(), this.from),
      this.kind.box,
      ...this.timed,
      this.spread,
      this.boxed,
      ...this.grouped,
      ...this.sloping,
      ...this.dotted,
      ...this.paired,
      field(m.chart_form_title_field(), this.title),
      field(m.chart_form_refresh(), schedule),
    ];
    this.form.open(fields, place);
    // A source with nothing to read again has the checks field off, so the keys go first.
    const onRefresh = opening.t === "change" && opening.on === "refresh" && !this.refresh.disabled;
    (onRefresh ? this.refresh : this.first()).focus();
  }

  close(): void {
    this.form.close();
  }

  /** choose offers the columns of the source chosen, keeping each column
   * chosen whose header it has, and names it in an insert's title line. */
  private choose(): void {
    const chosen = (select: HTMLSelectElement): ChartColumn | undefined =>
      select.value === "" ? undefined : this.column(select.value);
    const [by, ...kept] = [
      this.by,
      this.sum,
      this.x,
      this.y,
      this.at,
      this.split,
      this.of,
      this.boxBy,
      this.dotsOf,
      this.between,
    ].map(chosen);
    this.source = this.sources[Number(this.from.value)] ?? this.source;
    if (this.opening.t === "insert") {
      this.form.heading.textContent = m.chart_form_title_source({ source: this.source.name });
    }
    this.offer(this.placeAt(by), kept);
    this.reveal();
  }

  /**
   * inserts offers the source's columns for a chart of column `col`: over time
   * where it holds dates, a histogram where it holds numbers, or else bars.
   */
  private inserts(col: number): void {
    this.offer(col);
    const numbered = [...this.of.options].some((made) => made.value === String(col));
    if (this.kind.value !== "bars" || !numbered) return;
    this.kind.value = "histogram";
    this.ask();
  }

  /** opensOn chooses `plot`'s kind, and the source's columns it names. */
  private opensOn(plot: Plot): void {
    // A stacked chart is bars split by a column; the form makes no horizon chart yet.
    this.kind.value = plot.t === "stack" ? "bars" : plot.t === "horizon" ? "time" : plot.t;
    if (plot.t === "scatter") this.offer(this.placeAt(plot.x), [undefined, plot.x, plot.y]);
    else if (plot.t === "time" || plot.t === "week" || plot.t === "heat" || plot.t === "horizon") {
      if (plot.t !== "week") this.per.value = plot.per;
      const by = plot.t === "heat" || plot.t === "horizon" ? this.placed(plot.by) : undefined;
      this.offer(by ?? this.placeAt(plot.at), [plot.sum, undefined, undefined, plot.at]);
    } else if (plot.t === "stack") {
      this.offer(this.placeAt(plot.by), [plot.sum, undefined, undefined, undefined, plot.split]);
    } else if (plot.t === "histogram" || plot.t === "box") {
      const by = plot.t === "box" ? plot.by : undefined;
      const unused = [undefined, undefined, undefined, undefined, undefined];
      this.offer(this.placeAt(plot.of), [...unused, plot.of, by]);
    } else if (plot.t === "dots" || plot.t === "slope") {
      this.measure.value = plot.measure ?? "mean";
      const unused = [undefined, undefined, undefined, undefined, undefined, undefined, undefined];
      const between = plot.t === "slope" ? plot.between : undefined;
      this.offer(this.placeAt(plot.by), [...unused, plot.of, between]);
    } else this.offer(this.placeAt(plot.by), [plot.sum]);
  }

  /** placeAt gives where the source holds `column`, or else its first column. */
  private placeAt(column: ChartColumn | undefined): number {
    return this.placed(column) ?? 0;
  }

  /** placed gives where the source holds `column`, found as a tally finds it. */
  private placed(column: ChartColumn | undefined): number | undefined {
    const headers = this.source.band.columns.map((c) => c.header);
    return column === undefined ? undefined : placeOf(column, headers);
  }

  /** first gives the column select the kind chosen asks for first. */
  private first(): HTMLSelectElement {
    if (this.kind.value === "time" || this.kind.value === "week") return this.at;
    if (this.kind.value === "histogram" || this.kind.value === "box") return this.of;
    return this.kind.value === "scatter" ? this.x : this.by;
  }

  /** offer fills the selects with the source's columns, choosing `by` and,
   * for Sum of, X and Y, where the source holds the number columns `kept`. X is
   * otherwise `by` where it holds numbers, or else the first number column, and
   * never Y's, and Y is otherwise one other than X. */
  private offer(by: number, kept: ReadonlyArray<ChartColumn | undefined> = []): void {
    const columns = this.source.band.columns;
    const numbers: number[] = [];
    const dates = columns.flatMap((c, i) => (c.kind === "date" || c.unit !== undefined ? [i] : []));
    this.at.replaceChildren(
      ...dates.map((i) => {
        const { header, unit } = columns[i]!;
        const made = fromFile(header, i);
        if (unit !== undefined) made.textContent += ` (${UNIT_WORDS[unit]()})`;
        return made;
      }),
    );
    this.by.replaceChildren();
    this.sum.replaceChildren(option(m.chart_form_sum_none(), ""));
    this.split.replaceChildren(option(m.chart_form_split_none(), ""));
    this.x.replaceChildren();
    this.y.replaceChildren();
    this.of.replaceChildren();
    this.boxBy.replaceChildren(option(m.chart_form_box_none(), ""));
    this.dotsOf.replaceChildren(option(m.chart_form_sum_none(), ""));
    this.between.replaceChildren(...columns.map((c, i) => fromFile(c.header, i)));
    for (const [i, c] of columns.entries()) {
      this.by.append(fromFile(c.header, i));
      this.split.append(fromFile(c.header, i));
      this.boxBy.append(fromFile(c.header, i));
      // Cells that do not read as numbers are left out of a sum or a scatter and counted.
      if (c.kind !== "num" && !c.flagged) continue;
      numbers.push(i);
      for (const offered of [this.sum, this.x, this.y, this.of, this.dotsOf]) {
        offered.append(fromFile(c.header, i));
      }
    }
    const held = (column?: ChartColumn): number | undefined => {
      const at = this.placed(column);
      return at !== undefined && numbers.includes(at) ? at : undefined;
    };
    const [sum, x, y] = kept.map(held);
    const at = this.placed(kept[3]);
    this.at.value = String(
      [at, by].find((i) => i !== undefined && dates.includes(i)) ?? dates[0] ?? "",
    );
    const xAt = x ?? [by, ...numbers].find((i) => numbers.includes(i) && i !== y) ?? y;
    const yAt = y ?? numbers.find((i) => i !== xAt) ?? xAt;
    this.by.value = String(clamp(by, columns.length - 1));
    this.sum.value = String(sum ?? "");
    this.split.value = String(this.placed(kept[4]) ?? "");
    this.boxBy.value = String(this.placed(kept[6]) ?? "");
    this.dotsOf.value = String(held(kept[7]) ?? "");
    // A slope's states are a text column's values other than By's, as dates and numbers have their own charts.
    const others = columns.flatMap((c, i) => (i === by ? [] : [{ kind: c.kind, i }]));
    const between = others.find(({ kind }) => kind === "text") ?? others[0];
    this.between.value = String(this.placed(kept[8]) ?? between?.i ?? "");
    this.stated(false);
    this.x.value = String(xAt ?? "");
    this.y.value = String(yAt ?? "");
    this.of.value = String(held(kept[5]) ?? (numbers.includes(by) ? by : (numbers[0] ?? "")));

    const scatters = numbers.length >= SCATTER_COLUMNS;
    this.kind.disable("scatter", !scatters);
    if (!scatters && this.kind.value === "scatter") this.kind.value = "bars";
    for (const t of ["time", "week", "heat"]) {
      this.kind.disable(t, dates.length === 0);
      if (dates.length === 0 && this.kind.value === t) this.kind.value = "bars";
    }
    for (const t of ["histogram", "box"]) {
      this.kind.disable(t, numbers.length === 0);
      if (numbers.length === 0 && this.kind.value === t) this.kind.value = "bars";
    }
    // A date column selected in the grid opens the form on a chart over time of it.
    if (this.opening.t === "insert" && this.kind.value === "bars" && dates.includes(by)) {
      this.kind.value = "time";
    }
    this.dated();
  }

  /** ask shows the fields the kind chosen asks for, and the title it makes. */
  private ask(): void {
    const t = this.kind.value;
    for (const line of this.timed) line.hidden = t !== "time" && t !== "week" && t !== "heat";
    const { order, unit } = this.source.band.columns[Number(this.at.value)] ?? {};
    this.timed[1]!.hidden ||= order === undefined || unit !== undefined;
    // A week has its hours, so a week heatmap asks for no size.
    this.timed[2]!.hidden ||= t === "week";
    const spreads = t === "histogram" || t === "box";
    this.spread.hidden = !spreads;
    this.boxed.hidden = t !== "box";
    this.grouped[0]!.hidden = t === "scatter" || t === "time" || t === "week" || spreads;
    this.grouped[1]!.hidden = t === "scatter" || t === "dots" || t === "slope" || spreads;
    const measures = t === "dots" || t === "slope";
    this.dotted[0]!.hidden = !measures;
    this.dotted[1]!.hidden = !measures || this.dotsOf.value === "";
    for (const line of this.sloping) line.hidden = t !== "slope";
    // A slope's states are another column's than its values', and two, never one.
    for (const made of this.between.options) made.disabled = made.value === this.by.value;
    for (const made of this.stateTo.options) made.disabled = made.value === this.stateFrom.value;
    const other = [...this.stateTo.options].find((made) => !made.disabled)?.value ?? "";
    if (this.stateTo.value === this.stateFrom.value) this.stateTo.value = other;
    // A box plot splits by another column, never by its numbers'.
    for (const made of this.boxBy.options) made.disabled = made.value === this.of.value;
    if (this.boxBy.value === this.of.value) this.boxBy.value = "";
    this.grouped[2]!.hidden = t !== "bars";
    // A value splits by another column, never by its own.
    for (const made of this.split.options) made.disabled = made.value === this.by.value;
    if (this.split.value === this.by.value) this.split.value = "";
    for (const line of this.paired) line.hidden = t !== "scatter";
    this.name();
  }

  /** plot gives what the chart draws: bars or a pie of the rows, or of the sum,
   * per value of `by`, or a scatter of `y` against `x`. */
  private plot(): Plot {
    if (this.kind.value === "scatter") {
      return { t: "scatter", x: this.column(this.x.value), y: this.column(this.y.value) };
    }
    if (this.kind.value === "time") return this.overTime();
    if (this.kind.value === "week") return this.weekly();
    if (this.kind.value === "heat") return this.heated();
    const of = this.column(this.of.value);
    if (this.kind.value === "histogram") return { t: "histogram", of, span: this.span };
    if (this.kind.value === "box") {
      const by = this.boxBy.value === "" ? {} : { by: this.column(this.boxBy.value) };
      return { t: "box", of, ...by, span: this.span };
    }
    const t = this.kind.value === "pie" ? "pie" : "bars";
    const by = this.column(this.by.value);
    if (this.kind.value === "dots") return this.dots(by);
    if (this.kind.value === "slope") {
      const between = this.column(this.between.value);
      const [from, to] = [this.stateFrom.value, this.stateTo.value];
      return { t: "slope", by, between, from, to, ...this.measured() };
    }
    const sum = this.sum.value === "" ? {} : { sum: this.column(this.sum.value) };
    if (t === "bars" && this.split.value !== "") {
      return { t: "stack", by, split: this.column(this.split.value), ...sum };
    }
    return { t, by, ...sum };
  }

  /**
   * dots gives a dot plot per value of `by`, of Of's column at Measure's
   * measure, or of the rows where Of names none, standing the values a person
   * moved first while `by` is the column they were moved in.
   */
  private dots(by: ChartColumn): Plot {
    const moved = this.moved;
    const kept = moved?.by.col === by.col && moved.by.header === by.header;
    const order = moved !== undefined && kept ? { order: moved.order } : {};
    return { t: "dots", by, ...this.measured(), ...order };
  }

  /** measured gives Of's column at Measure's measure, or nothing where Of names none, which counts rows. */
  private measured(): { of?: undefined } | { of: ChartColumn; measure: DotMeasure } {
    if (this.dotsOf.value === "") return {};
    const measure = this.measure.value === "sum" ? "sum" : "mean";
    return { of: this.column(this.dotsOf.value), measure };
  }

  /** stated offers Between's commonest values as From and To, and chooses two of them, or those the slope opened on. */
  private stated(asks = true): void {
    const col = Number(this.between.value);
    const values = commonest(this.source.band, col, SAMPLE_ROWS);
    const states = this.states;
    const kept = states !== undefined && this.placed(states.between) === col ? states : undefined;
    for (const state of kept === undefined ? [] : [kept.from, kept.to]) {
      if (!values.includes(state)) values.push(state);
    }
    for (const offered of [this.stateFrom, this.stateTo])
      offered.replaceChildren(...values.map(stateOption));
    const [first, second] = twoOf(values);
    this.stateFrom.value = kept?.from ?? first;
    this.stateTo.value = kept?.to ?? second;
    if (asks) this.ask();
  }

  /**
   * dated offers how the chosen date column's dates read: its order, as a cell
   * of it that reads both ways writes it, chosen as the chart opened on read
   * it while its date column stays, or as the sample decided, or else as the
   * language reads it; and Hour where a cell writes a time of day.
   */
  private dated(): void {
    const col = Number(this.at.value);
    const { order, unit } = this.source.band.columns[col] ?? {};
    const cells: string[] = [];
    for (let row = 0; row < SAMPLE_ROWS && this.source.band.ready(row); row++) {
      cells.push(this.source.band.raw(row, col));
    }
    const both = cells.find(
      (v) =>
        readDate(v, "day") !== readDate(v, "month") &&
        readDate(v, "day") !== undefined &&
        readDate(v, "month") !== undefined,
    );
    // A cell that reads both ways names the day and month of each reading, its year as written.
    const words = (reading: Order, said: () => string): string => {
      if (both === undefined) return said();
      const minute = readDate(both, reading)!;
      const day = civilFromDays(Math.floor(minute / DAY_MINUTES)).day;
      return m.chart_form_reads({ value: both, day, month: monthOf(minute) });
    };
    this.order.replaceChildren(
      ...ORDERS.map(([reading, said]) => option(words(reading, said), reading)),
    );
    const read = this.read;
    const kept =
      read !== undefined && "order" in read && read.at.col === col ? read.order : undefined;
    const language: Order = getLocale() === MONTH_FIRST ? "month" : "day";
    const reading = kept ?? (order === "day" || order === "month" ? order : language);
    this.order.value = reading;
    // A cell writes a time of day whichever order it reads in.
    const minute = (v: string): number | undefined =>
      unit === undefined ? (readDate(v, "day") ?? readDate(v, "month")) : readDate(v, unit);
    const timed = cells.some((v) => (minute(v) ?? 0) % DAY_MINUTES !== 0);
    const hour = [...this.per.options].find((made) => made.value === "hour")!;
    hour.disabled = !timed && this.per.value !== "hour";
    this.ask();
  }

  /**
   * overTime gives an over-time chart of `at` per Per's size, summing Sum of
   * if it names a column, its dates read as Unix time where the column is
   * that, or else in the order chosen.
   */
  private overTime(): TimePlot {
    const at = this.column(this.at.value);
    const per = PERS.find(([size]) => size === this.per.value)?.[0] ?? "auto";
    const sum = this.sum.value === "" ? {} : { sum: this.column(this.sum.value) };
    return { t: "time", at, per, ...sum, ...this.reading(at) };
  }

  /** weekly gives a week heatmap of `at`, summing Sum of if it names a column, its dates read as an over-time chart's. */
  private weekly(): WeekPlot {
    const at = this.column(this.at.value);
    const sum = this.sum.value === "" ? {} : { sum: this.column(this.sum.value) };
    return { t: "week", at, ...sum, ...this.reading(at) };
  }

  /** heated gives a heatmap of By's values per Per's size of `at`, summing Sum of if it names a column. */
  private heated(): HeatPlot {
    const [by, at] = [this.column(this.by.value), this.column(this.at.value)];
    const per = PERS.find(([size]) => size === this.per.value)?.[0] ?? "auto";
    const sum = this.sum.value === "" ? {} : { sum: this.column(this.sum.value) };
    return { t: "heat", by, at, ...sum, per, ...this.reading(at) };
  }

  /** reading gives how `at`'s dates read: as Unix time where the column is that, or else in the order chosen. */
  private reading(at: ChartColumn): Reading {
    const unit = this.source.band.columns[at.col]?.unit;
    if (unit !== undefined) return { unit };
    return { order: ORDERS.find(([reading]) => reading === this.order.value)?.[0] ?? "day" };
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

  /** every chooses the Refresh option of `minutes`, or else Every… with the
   * hours they make where those are whole, or the minutes. */
  private every(minutes: number): void {
    const offered = SCHEDULES.some(([each]) => each === minutes);
    this.refresh.value = offered ? String(minutes) : EVERY;
    if (!offered) {
      const unit = minutes % HOUR_MINUTES === 0 ? HOUR_MINUTES : ONE_MINUTE;
      this.count.value = String(minutes / unit);
      this.unit.value = String(unit);
    }
    this.reveal();
  }

  /** reveal shows Every…'s number and unit while it is chosen. A source with
   * nothing to read again is checked by hand, whatever was chosen. */
  private reveal(): void {
    if (READS_NOTHING[rereads(this.source)] !== undefined) this.refresh.value = String(BY_HAND);
    const preset = this.refresh.value !== EVERY;
    this.count.hidden = preset;
    this.unit.hidden = preset;
    this.tell();
  }

  /** tell says in the note what a check reads of the source chosen while
   * Refresh holds a schedule, or else what Enter and Esc do. Over a source with
   * nothing to read again, Refresh is off and the note says why. */
  private tell(): void {
    const reads = rereads(this.source);
    const named = { name: this.source.name };
    const why = READS_NOTHING[reads]?.(named);
    for (const control of [this.refresh, this.count, this.unit]) {
      control.disabled = why !== undefined;
      control.title = why ?? "";
    }
    const hint = this.opening.t === "change" ? m.chart_form_hint_change() : m.chart_form_hint();
    const checks = why !== undefined || this.refresh.value !== String(BY_HAND);
    this.form.say(checks ? CHECKS[reads](named) : hint, false);
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
