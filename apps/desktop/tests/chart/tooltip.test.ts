/**
 * @fileoverview What a chart's marks are worth, from tooltip.ts: a bar's row
 * is worth the value it measures and a slice its measure and its share, each
 * labelled by the file's text, and which mark a pointer is over.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { Group, Groups } from "@engine";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { bars } from "@renderer/chart/bars";
import { pie } from "@renderer/chart/pie";
import { barTargets, sliceTargets } from "@renderer/chart/tooltip";
import type { Reading, Target } from "@renderer/chart/tooltip";
import { holding } from "../charted.ts";

const REGION = { col: 1, header: "region" };
const REVENUE = { col: 5, header: "revenue" };
const ROWS = { t: "bars", by: REGION } as const;
const SUMS = { ...ROWS, sum: REVENUE };
const SHARES = { t: "pie", by: REGION, sum: REVENUE } as const;

/** A tally of `groups` alone. */
function tallyOf(...groups: Group[]): Groups {
  const none = { values: 0, rows: 0, sum: 0 };
  return { groups, others: none, below: none, rest: none, skipped: { blank: 0, unparsed: 0 } };
}

const REGIONS = tallyOf(
  { value: "North", rows: 1204, sum: 48160.5 },
  { value: "South", rows: 812, sum: 32480 },
  { value: "", rows: 301, sum: 0 },
);

/** A plot that holds every region. */
const TALL = holding(REGIONS.groups.length);

/** What a target says: each reading's value, and its label's text and tag. */
const said = ({ said }: Target): Array<[string, string | null, string]> =>
  said().map(({ value, label }: Reading) => [value, label.textContent, label.nodeName]);

afterEach(() => {
  void setLocale(baseLocale, { reload: false });
  document.body.replaceChildren();
});

test("a bar's row is worth the rows it counts, labelled by the file's text, marked as the file's", () => {
  const box = bars(ROWS, REGIONS, TALL);
  const { all } = barTargets(ROWS, REGIONS, box);
  expect(all.map((target) => target.mark)).toStrictEqual([
    ...box.querySelectorAll(".chart-bar-row"),
  ]);
  expect(all.map(said)).toStrictEqual([
    [["1,204", "North", "BDI"]],
    [["812", "South", "BDI"]],
    [["301", m.chart_blank_value(), "SPAN"]],
  ]);
  const [north] = all[0]!.said();
  expect((north!.label as Element).classList.contains("from-file")).toBe(true);
  expect(all[0]!.at).toBe(box.querySelector(".chart-bar-tip"));
  expect(all[0]!.key).toBe("var(--accent)");
  // A plot with no room for the values leaves the box the bar to stand by.
  for (const tip of box.querySelectorAll(".chart-bar-tip")) tip.remove();
  expect(barTargets(ROWS, REGIONS, box).all[0]!.at).toBe(box.querySelector(".chart-bar"));
});

test("a sum per value is worth each value's sum, in the language chosen", () => {
  const box = bars(SUMS, REGIONS, TALL);
  void setLocale("es", { reload: false });
  const { all } = barTargets(SUMS, REGIONS, box);
  expect(all.map((target) => said(target)[0]![0])).toStrictEqual(["48.160,5", "32.480", "0"]);
});

test("a label is the file's text and never markup", () => {
  const markup = '<img src="x" onerror="alert(1)">';
  const one = tallyOf({ value: markup, rows: 3, sum: 0 });
  const [target] = barTargets(ROWS, one, bars(ROWS, one, TALL)).all;
  const [{ label }] = target!.said();
  expect(label.textContent).toBe(markup);
  expect((label as Element).querySelector("img")).toBeNull();
});

test("the row under a pointer is the target, from its label or its bar, and the box between rows is none", () => {
  const box = bars(ROWS, REGIONS, TALL);
  const { under } = barTargets(ROWS, REGIONS, box);
  const [label, bar] = [
    box.querySelector(".chart-bar-label"),
    box.querySelectorAll(".chart-bar")[1],
  ];
  expect(under(label, 0, 0)).toBe(0);
  expect(under(bar!, 0, 0)).toBe(1);
  expect(under(box, 0, 0)).toBeUndefined();
  expect(under(null, 0, 0)).toBeUndefined();
});

/** Eight values sent, the largest first: six for slices, and two more for Other. */
const EIGHT = tallyOf(
  ...[80, 70, 60, 50, 40, 30, 20, 10].map((rows, i) => ({ value: `v${i + 1}`, rows, sum: rows })),
);

test("a slice is worth what it measures, labelled by its value and its share, under its own colour", () => {
  const box = pie(SHARES, REGIONS);
  const { all, under } = sliceTargets(SHARES, REGIONS, box);
  expect(all.map((target) => target.mark)).toStrictEqual([...box.querySelectorAll(".chart-slice")]);
  expect(all.map(said)).toStrictEqual([
    [["48,160.5", "North · 60%", "SPAN"]],
    [["32,480", "South · 40%", "SPAN"]],
  ]);
  expect(all.map((target) => target.key)).toStrictEqual(["var(--chart-1)", "var(--chart-2)"]);
  expect(all[0]!.said()[0]!.label.firstChild).toMatchObject({
    nodeName: "BDI",
    textContent: "North",
  });
  expect(under(box.querySelectorAll(".chart-slice")[1]!, 0, 0)).toBe(1);
  expect(under(box.querySelector(".chart-slice-label"), 0, 0)).toBeUndefined();
});

test("Other is worth what it adds up, under the caption's ink, and says the app's word", () => {
  const { all } = sliceTargets(
    { t: "pie", by: REGION },
    EIGHT,
    pie({ t: "pie", by: REGION }, EIGHT),
  );
  const other = all.at(-1)!;
  expect(said(other)).toStrictEqual([["30", `${m.chart_pie_other()} · 8.3%`, "SPAN"]]);
  expect(other.key).toBe("var(--ink-3)");
});
