/**
 * @fileoverview What a chart's caption says of how much of its source it has
 * read, from the coverage its latest tally carries: the share read while the
 * tally is partial, and the rows once it is complete, then the cells the tally
 * left out. The track under the head shows the same share while the chart
 * reads, and the plot says why it draws nothing while it has nothing to draw.
 * At its right end it says how often its source is checked.
 */

import { BY_HAND, DAY_MINUTES, HOUR_MINUTES } from "@document";
import type { ChartColumn, Plot } from "@document";
import type { Coverage, GroupsTally, SampleTally, Skipped, Tally } from "@engine";
import { m } from "@paraglide/messages";
import type { Heard } from "@renderer/charts";
import { columnLabel } from "@renderer/grid/rows";
import { list, num, percent } from "@renderer/locale";
import { say } from "@renderer/said";

/** What a chart's plot says in place of what it cannot draw, and the action it offers. */
export interface Body {
  words: string;
  action?: Mend;
}

/**
 * A button that mends what a plot cannot draw: Re-point for a missing source
 * and Connect for one waiting on its bucket, which open the sources panel, or
 * Edit chart for a column that has gone, which opens the chart form.
 */
export interface Mend {
  words: string;
  opens: "panel" | "form";
}

/**
 * share gives how much of its source a tally has read, from 0 to 1. The total
 * is an estimate until the index completes, so the rows read can run past it,
 * and a source of no rows has none to read.
 */
function share({ rows, total }: Coverage): number {
  return total > 0 ? Math.min(rows / total, 1) : 0;
}

/**
 * coverage gives what the caption says of how much of its source a chart has
 * read: nothing before a tally, or of one that could not be read; the share
 * read while the tally is partial; and the rows once it is complete.
 */
export function coverage(latest: Tally | undefined): string {
  if (latest === undefined || latest.t === "unread") return "";
  const { rows, complete } = latest.coverage;
  if (complete) return m.rows_count({ count: rows });
  return m.chart_partial({ read: percent(share(latest.coverage)) });
}

/** skipped gives what `latest` left out, where it is a tally the chart could read. */
function skipped(latest: Tally | undefined): Skipped | undefined {
  return latest === undefined || latest.t === "unread" ? undefined : latest.skipped;
}

/**
 * blank gives what the caption says of the cells a tally left out as blank,
 * or nothing where it left out none. A scatter counts a row it could not
 * place once, as blank where neither of its cells holds a word.
 */
export function blank(latest: Tally | undefined): string {
  const left = skipped(latest)?.blank ?? 0;
  return left > 0 ? m.chart_blank({ count: num(left) }) : "";
}

/**
 * notNumbers gives what the caption says of the cells a tally left out as not
 * numbers, or nothing where it left out none. A scatter counts such a row once.
 */
export function notNumbers(latest: Tally | undefined): string {
  const left = skipped(latest)?.unparsed ?? 0;
  return left > 0 ? m.chart_not_numbers({ count: left }) : "";
}

/**
 * reading gives how far a chart has read its source, from 0 to 1, while it
 * reads: nothing of it before the first tally, or of a source being read
 * again, and then the latest tally's share until one completes. It is
 * undefined where nothing is read: the tally is complete, the chart cannot
 * read its column, its source is missing or waits on its bucket, or the
 * chart has gone.
 */
export function reading(heard: Heard | undefined): number | undefined {
  if (heard === undefined || heard.state === "missing" || heard.state === "unconnected") {
    return undefined;
  }
  const { latest } = heard;
  if (latest === undefined || heard.rereading === true) return 0;
  if (latest.t === "unread" || latest.coverage.complete) return undefined;
  return share(latest.coverage);
}

/** empty says whether `tally` has nothing a plot draws: no value, or no row a scatter can place. */
function empty(tally: GroupsTally | SampleTally): boolean {
  return tally.t === "groups" ? tally.groups.length === 0 : tally.plotted === 0;
}

/**
 * drawable gives the tally a window draws: the last complete one while the
 * next is read, or else the latest as it comes. A latest that says the chart
 * cannot read its source leaves nothing to draw, as no earlier tally stands
 * for it, and neither does a tally with nothing in it.
 */
export function drawable(heard: Heard | undefined): GroupsTally | SampleTally | undefined {
  const latest = heard?.latest;
  if (latest?.t === "unread") return undefined;
  const tally = heard?.complete ?? latest;
  return tally === undefined || empty(tally) ? undefined : tally;
}

/** The columns a plot's values come from, as the head names them. */
function valued(plot: Plot): string[] {
  const named = ({ header, col }: ChartColumn): string => columnLabel(header, col);
  return plot.t === "scatter" ? [named(plot.x), named(plot.y)] : [named(plot.by)];
}

/**
 * body gives what the plot says in place of a chart it cannot draw, or
 * undefined where it draws one: why the chart cannot read its column, that its
 * source is missing or waits on its bucket, with the action that mends it,
 * that it reads its source before the first tally, or that the tally has no
 * values in the plot's columns yet. A column that has gone offers Edit chart.
 */
export function body(plot: Plot, heard: Heard): Body | undefined {
  if (drawable(heard) !== undefined) return undefined;
  const { state, latest, name } = heard;
  if (latest?.t === "unread") {
    const words = say(latest.said);
    const gone = latest.said.t === "chart-column-gone";
    return gone ? { words, action: { words: m.chart_edit(), opens: "form" } } : { words };
  }
  if (state === "missing") {
    const action: Mend = { words: m.action_repoint(), opens: "panel" };
    return { words: m.chart_source_missing({ name }), action };
  }
  if (state === "unconnected") {
    const bucket = heard.bucket ?? name;
    return {
      words: m.chart_bucket_unconnected({ bucket }),
      action: { words: m.sources_connect_bucket({ bucket }), opens: "panel" },
    };
  }
  if (latest === undefined) return { words: m.chart_reading({ name }) };
  return { words: m.chart_no_values_yet({ columns: list(valued(plot)) }) };
}

/**
 * every gives what the caption calls a chart's schedule of `minutes` between
 * checks: an hour or a day by name, whole hours in hours, or else minutes, and
 * nothing for a chart read by hand.
 */
export function every(minutes: number): string {
  if (minutes === BY_HAND) return "";
  if (minutes === HOUR_MINUTES) return m.chart_every_hour();
  if (minutes === DAY_MINUTES) return m.chart_every_day();
  if (minutes % HOUR_MINUTES !== 0) return m.chart_every_minutes({ count: num(minutes) });
  return m.chart_every_hours({ count: num(minutes / HOUR_MINUTES) });
}
