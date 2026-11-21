/**
 * @fileoverview Each chart kind's module makes its plot's parts from the
 * modules that draw them: the title, the drawing and its marks, the table,
 * the summary and the caption's own words.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { Plot } from "@document";
import type { Group, GroupsTally, SampleTally, StackTally, TimeTally } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { bars as drawBars } from "@renderer/chart/bars";
import { COLUMN_PITCH_LEAST, columns, fitted } from "@renderer/chart/columns";
import type { ChartKind } from "@renderer/chart/kind";
import { bars } from "@renderer/chart/kinds/bars";
import { box } from "@renderer/chart/kinds/box";
import { dots } from "@renderer/chart/kinds/dots";
import { slope } from "@renderer/chart/kinds/slope";
import { heat } from "@renderer/chart/kinds/heat";
import { horizon } from "@renderer/chart/kinds/horizon";
import { week } from "@renderer/chart/kinds/week";
import { histogram } from "@renderer/chart/kinds/histogram";
import { KINDS } from "@renderer/chart/kinds/index";
import { pie } from "@renderer/chart/kinds/pie";
import { scatter } from "@renderer/chart/kinds/scatter";
import { stack } from "@renderer/chart/kinds/stack";
import { time } from "@renderer/chart/kinds/time";
import { belowZero, past, pie as drawPie } from "@renderer/chart/pie";
import { BARS_INSET } from "@renderer/chart/rows";
import { stack as drawStack } from "@renderer/chart/stack";
import { TICK_GAP, sampled, scatter as drawScatter } from "@renderer/chart/scatter";
import { spanned, valued } from "@renderer/chart/summary";
import type { Told } from "@renderer/chart/summary";
import { grouped, points, tableOf } from "@renderer/chart/table";
import { barTargets, pointTargets, sliceTargets } from "@renderer/chart/tooltip";
import type { Targets } from "@renderer/chart/tooltip";
import { madeTitle } from "@renderer/chart/window";
import { el } from "@renderer/shell/util";
import { ROOM, SCATTER } from "../charted.ts";

/** The file the summaries name. */
/** The plot's height a bar chart draws at, in CSS px. */
const HEIGHT = 240;

/** The columns the plots read. */
const REGION = { col: 1, header: "region" };
const REVENUE = { col: 5, header: "revenue" };

/** Rows per region, and the sum of revenue per region. */
const ROWS: Extract<Plot, { t: "bars" }> = { t: "bars", by: REGION };
const SUMS: Extract<Plot, { t: "bars" }> = { ...ROWS, sum: REVENUE };

/** Each region's share of the rows, and of the revenue. */
const SHARES: Extract<Plot, { t: "pie" }> = { t: "pie", by: REGION };
const SHARES_OF_SUM: Extract<Plot, { t: "pie" }> = { ...SHARES, sum: REVENUE };

/** A value sent of `rows` rows, whose cells sum to `sum`. */
const sent = (value: string, rows: number, sum = rows): Group => ({ value, rows, sum });

/** A complete tally of three regions, and of none. */
const none = { values: 0, rows: 0, sum: 0 };
const GROUPS: GroupsTally = {
  t: "groups",
  plot: ROWS,
  coverage: { rows: 6, total: 6, complete: true },
  groups: [sent("North", 3, 450.5), sent("South", 2, 120), sent("", 1, -20)],
  others: { values: 2, rows: 2, sum: 9 },
  below: none,
  rest: none,
  skipped: { blank: 0, unparsed: 0 },
};
const EMPTY: GroupsTally = { ...GROUPS, groups: [], others: none };

/** A scatter's tally, which no grouped kind draws. */
const SAMPLE: SampleTally = {
  t: "sample",
  plot: SCATTER.plot,
  coverage: { rows: 1, total: 1, complete: true },
  x: [1],
  y: [2],
  plotted: 1,
  least: { x: 1, y: 2 },
  most: { x: 1, y: 2 },
  skipped: { blank: 0, unparsed: 0 },
};

afterEach(async () => {
  await setLocale(baseLocale, { reload: false });
});

/** What the head calls the chart, as the table's caption. */
const called = (): HTMLElement => el("bdi", "", "rows per region");

/** The marks a drawing gives, as plain values. */
const marks = (all: Targets["all"]) =>
  all.map(({ mark, at, front, key }) => [mark, at, front, key]);

/** What a kind's module is to make of a plot and its tally: its parts, from their own modules. */
interface Parts {
  title: string;
  draw(): HTMLElement;
  targets(drawn: HTMLElement): Targets;
  table(): [HTMLElement[], HTMLElement[]];
  told: Told;
}

/** made checks that `kind` makes `parts` of `plot` and `tally`, and gives back its drawing. */
function made<P extends Plot>(
  kind: ChartKind<P>,
  plot: P,
  tally: GroupsTally | SampleTally,
  parts: Parts,
) {
  const of = kind(plot);
  expect(of.title()).toBe(parts.title);
  expect(madeTitle(plot)).toBe(parts.title);
  const drawing = of.drawing(tally, ROOM)!;
  const drawn = drawing.draw(HEIGHT);
  expect(drawn.outerHTML).toBe(parts.draw().outerHTML);
  expect(marks(drawing.targets(drawn).all)).toStrictEqual(marks(parts.targets(drawn).all));
  expect(drawing.table(called()).outerHTML).toBe(tableOf(parts.table(), called()).outerHTML);
  expect(drawing.told()).toStrictEqual(parts.told);
  return drawing;
}

/** groupedParts gives the parts a bar chart or a pie of `plot` makes of GROUPS, under `title`. */
function groupedParts(
  plot: Extract<Plot, { t: "bars" | "pie" }>,
  title: string,
  draw: () => HTMLElement,
  targets: (drawn: HTMLElement) => Targets,
): Parts {
  return { title, draw, targets, table: () => grouped(plot, GROUPS), told: valued(plot, GROUPS) };
}

test("a bar chart's kind makes the title, the drawing and its marks, the table and the summary a bar chart made", () => {
  for (const [plot, title] of [
    [ROWS, "rows per region"],
    [SUMS, "sum of revenue per region"],
  ] as const) {
    const draw = () => drawBars(plot, GROUPS, HEIGHT);
    const targets = (drawn: HTMLElement) => barTargets(plot, GROUPS, drawn);
    const drawing = made(bars, plot, GROUPS, groupedParts(plot, title, draw, targets));
    expect(drawing.empty).toBe(false);
    expect(drawing.notes()).toStrictEqual([]);
    expect(bars(plot).drawing(EMPTY, ROOM)?.empty).toBe(true);
    expect(bars(plot).drawing(SAMPLE, ROOM)).toBeUndefined();
  }
  expect(bars(SUMS).numbered).toStrictEqual([SUMS.sum]);
  expect(bars(SUMS).valued).toStrictEqual([REGION]);
});

test("a pie's kind makes what a pie made, and says how it counts the values past those kept and those at or below zero", () => {
  for (const [plot, title] of [
    [SHARES, "share of rows per region"],
    [SHARES_OF_SUM, "share of revenue per region"],
  ] as const) {
    const draw = () => drawPie(plot, GROUPS);
    const targets = (drawn: HTMLElement) => sliceTargets(plot, GROUPS, drawn);
    const drawing = made(pie, plot, GROUPS, groupedParts(plot, title, draw, targets));
    expect(drawing.notes()).toStrictEqual([past(plot, GROUPS), belowZero(plot, GROUPS)]);
    expect(pie(plot).drawing(SAMPLE, ROOM)).toBeUndefined();
  }
  expect(pie(SHARES_OF_SUM).numbered).toStrictEqual([REVENUE]);
});

test("a scatter's kind makes what a scatter made, and says what its sample leaves out", () => {
  const plot = SCATTER.plot;
  if (plot.t !== "scatter") throw new Error("the scatter fixture plots a scatter");
  const drawing = made(scatter, plot, SAMPLE, {
    title: "revenue against units",
    draw: () => drawScatter(SAMPLE),
    targets: (drawn) => pointTargets(plot, SAMPLE, drawn),
    table: () => points(plot, SAMPLE),
    told: spanned(plot, SAMPLE),
  });
  expect(drawing.notes()).toStrictEqual([sampled(SAMPLE)]);
  expect(scatter(plot).drawing({ ...SAMPLE, plotted: 0 }, ROOM)?.empty).toBe(true);
  expect(scatter(plot).drawing(GROUPS, ROOM)).toBeUndefined();
  expect(scatter(plot).numbered).toStrictEqual([plot.x, plot.y]);
});

test("each plot kind has its module", () => {
  expect(KINDS).toStrictEqual({
    bars,
    pie,
    scatter,
    time,
    stack,
    histogram,
    box,
    dots,
    slope,
    week,
    heat,
    horizon,
  });
});

test("a week heatmap's kind reads its dates as its plot says, and its numbers from its sum", () => {
  const at = { col: 0, header: "ordered" };
  const kind = week({ t: "week", at, sum: REVENUE, unit: "s" });
  expect(kind.dated).toStrictEqual({ at, reading: "s" });
  expect([kind.numbered, kind.valued]).toStrictEqual([[REVENUE], [at]]);
  expect(week({ t: "week", at, order: "day" }).numbered).toStrictEqual([]);
});

test("a slope chart's kind titles what it measures per value and its two states", () => {
  const between = { col: 0, header: "year" };
  const plot = { t: "slope", by: REGION, between, from: "2024", to: "2025" } as const;
  expect(slope(plot).title()).toBe("rows per region, 2024 to 2025");
  expect(slope({ ...plot, of: REVENUE, measure: "sum" }).title()).toBe(
    "sum of revenue per region, 2024 to 2025",
  );
});

test("a slope chart's kind reads its values, its states and its numbers from its columns", () => {
  const between = { col: 0, header: "year" };
  const plot = { t: "slope", by: REGION, between, from: "2024", to: "2025" } as const;
  const means = slope({ ...plot, of: REVENUE, measure: "mean" });
  expect([means.valued, means.numbered]).toStrictEqual([[REGION, between], [REVENUE]]);
});

test("a dot plot's kind titles its rows, its sum or its mean per value, and reads its numbers from its column", () => {
  const means = dots({ t: "dots", by: REGION, of: REVENUE, measure: "mean" });
  expect([means.title(), means.numbered]).toStrictEqual(["mean of revenue per region", [REVENUE]]);
  const sums = dots({ t: "dots", by: REGION, of: REVENUE, measure: "sum" });
  expect([sums.title(), sums.numbered]).toStrictEqual(["sum of revenue per region", [REVENUE]]);
  const rows = dots({ t: "dots", by: REGION });
  expect([rows.title(), rows.numbered]).toStrictEqual(["rows per region", []]);
});

/** Rows per region by channel, two regions in two channels and Other. */
const STACKED: Extract<Plot, { t: "stack" }> = {
  t: "stack",
  by: { col: 1, header: "region" },
  split: { col: 3, header: "channel" },
};
const STACKS: StackTally = {
  t: "stack",
  plot: STACKED,
  coverage: { rows: 9, total: 9, complete: true },
  series: ["web", "direct"],
  values: [
    {
      value: "North",
      cells: [
        { rows: 3, sum: 0 },
        { rows: 2, sum: 0 },
      ],
      other: { rows: 1, sum: 0 },
      total: { rows: 6, sum: 0 },
    },
    {
      value: "South",
      cells: [
        { rows: 0, sum: 0 },
        { rows: 3, sum: 0 },
      ],
      other: { rows: 0, sum: 0 },
      total: { rows: 3, sum: 0 },
    },
  ],
  others: { values: 0, rows: 0, sum: 0 },
  below: { values: 0, rows: 0, sum: 0 },
  rest: { rows: 0, sum: 0 },
  unsplit: 0,
  skipped: { blank: 0, unparsed: 0 },
};

test("a stacked chart's kind draws its tally as stack.ts draws it, and none of another kind", () => {
  const drawing = stack(STACKED).drawing(STACKS, ROOM)!;
  expect(drawing.draw(HEIGHT).outerHTML).toBe(drawStack(STACKED, STACKS, HEIGHT, ROOM).outerHTML);
  expect(drawing.empty).toBe(false);
  expect(stack(STACKED).drawing({ ...STACKS, values: [] }, ROOM)?.empty).toBe(true);
  expect(stack(STACKED).drawing(GROUPS, ROOM)).toBeUndefined();
});

/** Rows per day of the sales export's dates, sent from days to years. */
const DATED: Extract<Plot, { t: "time" }> = {
  t: "time",
  at: { col: 0, header: "date" },
  per: "day",
  order: "day",
};
const TIMES: TimeTally = {
  t: "time",
  plot: DATED,
  coverage: { rows: 7, total: 7, complete: true },
  levels: [
    { per: "day", from: 20_635, span: 9, offset: 0, rows: [3, 0, 0, 0, 0, 0, 0, 0, 4], sum: [] },
    { per: "week", from: 2_948, span: 2, offset: 0, rows: [3, 4], sum: [] },
    { per: "month", from: 678, span: 1, offset: 0, rows: [7], sum: [] },
  ],
  undated: { rows: 0, sum: 0 },
  dates: { blank: 0, unparsed: 0, other: 0 },
  skipped: { blank: 0, unparsed: 0 },
};

test("an over-time chart's kind draws its tally as columns of the finest level its plot holds", () => {
  // Room for one character of labels and the two weeks' columns, and not the nine days'.
  const weeks = TIMES.levels[1]!.span;
  const width = 2 * BARS_INSET + ROOM.ch + TICK_GAP + weeks * COLUMN_PITCH_LEAST;
  const narrow = { ...ROOM, width };
  for (const room of [ROOM, narrow]) {
    const drawing = time(DATED).drawing(TIMES, room)!;
    const drawn = columns(fitted(TIMES.levels, false, room)!, false, room);
    expect(drawing.draw(HEIGHT).outerHTML).toBe(drawn.outerHTML);
    expect(drawing.empty).toBe(false);
  }
  expect(fitted(TIMES.levels, false, narrow)?.level.per).toBe("week");
  expect(time(DATED).drawing({ ...TIMES, levels: [] }, ROOM)?.empty).toBe(true);
  expect(time(DATED).drawing(GROUPS, ROOM)).toBeUndefined();
});

test("an over-time chart's drawing wants the next batch of a level it draws past the periods sent, and none of one sent whole", () => {
  const years = { per: "year" as const, from: 0, span: 2_000, offset: 0, rows: [1], sum: [] };
  const long = { ...TIMES, levels: [{ ...years, rows: Array.from({ length: 1_024 }, () => 1) }] };
  expect(time(DATED).drawing(long, ROOM)?.wanted?.()).toStrictEqual([
    { per: "year", offset: 1_024 },
  ]);
  expect(time(DATED).drawing(TIMES, ROOM)?.wanted?.()).toStrictEqual([]);
});

test("an over-time chart's caption says when its plot draws coarser than its size, or is too narrow for any size sent", async () => {
  const weeks = TIMES.levels[1]!.span;
  const narrow = {
    ...ROOM,
    width: 2 * BARS_INSET + ROOM.ch + TICK_GAP + weeks * COLUMN_PITCH_LEAST,
  };
  const said = (plot: typeof DATED, room: typeof ROOM) => {
    const drawing = time(plot).drawing(TIMES, room);
    return [drawing?.kept?.(), ...(drawing?.notes() ?? [])];
  };
  expect(said(DATED, ROOM)).toStrictEqual(["", ""]);
  expect(said(DATED, narrow)).toStrictEqual(["drawn per week", "too narrow for a column per day"]);
  expect(said({ ...DATED, per: "auto" }, narrow)).toStrictEqual(["", ""]);
  expect(said(DATED, { ...ROOM, width: 2 * BARS_INSET })).toStrictEqual([
    "",
    "too narrow for a column per month",
  ]);
  await setLocale("es", { reload: false });
  expect(said(DATED, narrow)).toStrictEqual([
    "dibujado por semana",
    "demasiado estrecho para una columna por día",
  ]);
});

test("an over-time chart's kind names its date column and how it reads it, for its not-dates to find, and no other kind does", () => {
  expect(time(DATED).dated).toStrictEqual({ at: DATED.at, reading: "day" });
  expect(time({ t: "time", at: DATED.at, per: "auto", unit: "ms" }).dated?.reading).toBe("ms");
  expect(bars(ROWS).dated).toBeUndefined();
});

test("a box plot is titled by its column, and by both where it splits by another", () => {
  const revenue = { col: 5, header: "revenue" };
  const region = { col: 1, header: "region" };
  expect(madeTitle({ t: "box", of: revenue, span: "most" })).toBe("revenue");
  expect(madeTitle({ t: "box", of: revenue, by: region, span: "most" })).toBe("revenue per region");
});

test("a heatmap over periods' kind titles what it measures per value, per its size or over its dates", async () => {
  const at = { col: 0, header: "ordered" };
  const plot = { t: "heat", by: REGION, at, per: "month", order: "day" } as const;
  expect(heat(plot).title()).toBe("rows per region per month of ordered");
  expect(heat({ ...plot, sum: REVENUE, per: "auto" }).title()).toBe(
    "sum of revenue per region over ordered",
  );
  await setLocale("es", { reload: false });
  expect(heat({ ...plot, sum: REVENUE }).title()).toBe(
    "suma de revenue por region por mes de ordered",
  );
  await setLocale(baseLocale, { reload: false });
});

test("a horizon chart's kind titles what it measures as an over-time chart does, or per value as a heatmap does", async () => {
  const at = { col: 0, header: "ordered" };
  const plot = { t: "horizon", at, per: "month", order: "day" } as const;
  expect(horizon(plot).title()).toBe("rows per month of ordered");
  expect(horizon({ ...plot, sum: REVENUE, per: "auto" }).title()).toBe(
    "sum of revenue over ordered",
  );
  expect(horizon({ ...plot, by: REGION }).title()).toBe("rows per region per month of ordered");
  await setLocale("es", { reload: false });
  expect(horizon({ ...plot, by: REGION, sum: REVENUE }).title()).toBe(
    "suma de revenue por region por mes de ordered",
  );
  await setLocale(baseLocale, { reload: false });
});
