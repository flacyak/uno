/**
 * @fileoverview Each chart kind's module makes its plot's parts from the
 * modules that draw them: the title, the drawing and its marks, the table,
 * the summary and the caption's own words.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Plot } from "@document";
import type { Group, GroupsTally, SampleTally } from "@engine";
import { bars as drawBars } from "@renderer/chart/bars";
import type { ChartKind } from "@renderer/chart/kind";
import { bars } from "@renderer/chart/kinds/bars";
import { KINDS } from "@renderer/chart/kinds/index";
import { pie } from "@renderer/chart/kinds/pie";
import { scatter } from "@renderer/chart/kinds/scatter";
import { time } from "@renderer/chart/kinds/time";
import { belowZero, past, pie as drawPie } from "@renderer/chart/pie";
import { sampled, scatter as drawScatter } from "@renderer/chart/scatter";
import { spanned, valued } from "@renderer/chart/summary";
import type { Told } from "@renderer/chart/summary";
import { grouped, points, tableOf } from "@renderer/chart/table";
import { barTargets, pointTargets, sliceTargets } from "@renderer/chart/tooltip";
import type { Targets } from "@renderer/chart/tooltip";
import { madeTitle } from "@renderer/chart/window";
import { el } from "@renderer/shell/util";
import { SCATTER } from "../charted.ts";

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
  const drawing = of.drawing(tally)!;
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
    expect(bars(plot).drawing(EMPTY)?.empty).toBe(true);
    expect(bars(plot).drawing(SAMPLE)).toBeUndefined();
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
    expect(pie(plot).drawing(SAMPLE)).toBeUndefined();
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
  expect(scatter(plot).drawing({ ...SAMPLE, plotted: 0 })?.empty).toBe(true);
  expect(scatter(plot).drawing(GROUPS)).toBeUndefined();
  expect(scatter(plot).numbered).toStrictEqual([plot.x, plot.y]);
});

test("each plot kind has its module", () => {
  expect(KINDS).toStrictEqual({ bars, pie, scatter, time });
});
