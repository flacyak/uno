/**
 * @fileoverview Each chart kind's module makes what a window made of its plot
 * before the window looked kinds up: the title, the drawing and its marks,
 * the table, the summary and the caption's own words.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Plot } from "@document";
import type { Group, GroupsTally, SampleTally } from "@engine";
import { bars as drawBars } from "@renderer/chart/bars";
import type { ChartKind } from "@renderer/chart/kind";
import { bars } from "@renderer/chart/kinds/bars";
import { summary, summaryOf } from "@renderer/chart/summary";
import { table } from "@renderer/chart/table";
import { targets } from "@renderer/chart/tooltip";
import { madeTitle } from "@renderer/chart/window";
import { el } from "@renderer/shell/util";
import { SCATTER } from "../charted.ts";

/** The file the summaries name. */
const NAME = "sales-q3.csv";

/** The plot's height a bar chart draws at, in CSS px. */
const HEIGHT = 240;

/** The columns the plots read. */
const REGION = { col: 1, header: "region" };
const REVENUE = { col: 5, header: "revenue" };

/** Rows per region, and the sum of revenue per region. */
const ROWS: Extract<Plot, { t: "bars" }> = { t: "bars", by: REGION };
const SUMS: Extract<Plot, { t: "bars" }> = { ...ROWS, sum: REVENUE };

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
const marks = (all: ReturnType<typeof targets>["all"]) =>
  all.map(({ mark, at, front, key }) => [mark, at, front, key]);

/** made checks that `kind` makes what the window made of `plot` and `tally`. */
function made<P extends Plot>(
  kind: ChartKind<P>,
  plot: P,
  tally: GroupsTally | SampleTally,
  draw: () => HTMLElement,
) {
  const of = kind(plot);
  expect(of.title()).toBe(madeTitle(plot));
  const drawing = of.drawing(tally)!;
  const drawn = drawing.draw(HEIGHT);
  expect(drawn.outerHTML).toBe(draw().outerHTML);
  expect(marks(drawing.targets(drawn).all)).toStrictEqual(marks(targets(plot, tally, drawn).all));
  expect(drawing.table(called()).outerHTML).toBe(table(plot, tally, called()).outerHTML);
  const title = madeTitle(plot);
  const { rows } = tally.coverage;
  expect(summaryOf(title, NAME, rows, drawing.told())).toStrictEqual(
    summary(title, NAME, plot, tally),
  );
  return drawing;
}

test("a bar chart's kind makes the title, the drawing and its marks, the table and the summary a bar chart made", () => {
  for (const plot of [ROWS, SUMS]) {
    const drawing = made(bars, plot, GROUPS, () => drawBars(plot, GROUPS, HEIGHT));
    expect(drawing.empty).toBe(false);
    expect(drawing.notes()).toStrictEqual([]);
    expect(bars(plot).drawing(EMPTY)?.empty).toBe(true);
    expect(bars(plot).drawing(SAMPLE)).toBeUndefined();
  }
  expect(bars(SUMS).numbered).toStrictEqual([SUMS.sum]);
  expect(bars(SUMS).valued).toStrictEqual([REGION]);
});
