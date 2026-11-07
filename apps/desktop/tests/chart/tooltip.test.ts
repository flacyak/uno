/**
 * @fileoverview What a chart's marks are worth, from tooltip.ts: a bar's row
 * is worth the value it measures, a slice its measure and its share, and a
 * point its x and its y, each labelled by the file's text; which mark a
 * pointer is over, a point being the nearest within HIT_RADIUS; and the box
 * that says it beside the mark under the pointer, inside the window.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { Group, Groups, GroupsTally, Sample, SampleTally } from "@engine";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { bars } from "@renderer/chart/bars";
import { pie } from "@renderer/chart/pie";
import { scatter } from "@renderer/chart/scatter";
import {
  HIT_RADIUS,
  NONE,
  TIP_EDGE,
  TIP_OFFSET,
  Tooltip,
  barTargets,
  pointTargets,
  sliceTargets,
  stood,
  targets,
} from "@renderer/chart/tooltip";
import type { Reading, Target, Targets } from "@renderer/chart/tooltip";
import { el } from "@renderer/shell/util";
import { holding } from "../charted.ts";

const REGION = { col: 1, header: "region" };
const REVENUE = { col: 5, header: "revenue" };
const ROWS = { t: "bars", by: REGION } as const;
const SUMS = { ...ROWS, sum: REVENUE };
const SHARES = { t: "pie", by: REGION, sum: REVENUE } as const;
const AGAINST = { t: "scatter", x: { col: 4, header: "units" }, y: REVENUE } as const;

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

/** A tally that sent `x` and `y` and plotted no other row. */
function sampleOf(x: number[], y: number[]): Sample {
  const least = { x: Math.min(...x), y: Math.min(...y) };
  const most = { x: Math.max(...x), y: Math.max(...y) };
  return { x, y, plotted: x.length, least, most, skipped: { blank: 0, unparsed: 0 } };
}

/** Units against revenue: points a quarter of the way along and up, and at both ends. */
const SALES = sampleOf([0, 50, 200], [0, 1000, 4000]);

/** The points' box, laid out `width` px wide and as high, at the page's corner. */
function plotted(sample: Sample, width: number): HTMLElement {
  const box = scatter(sample);
  const rect = new DOMRect(0, 0, width, width);
  Object.defineProperty(box.querySelector(".chart-points"), "getBoundingClientRect", {
    value: () => rect,
  });
  return box;
}

test("a point is worth its x and its y, each named by its column, or the app's name for one with none", () => {
  const { all } = pointTargets(AGAINST, SALES, plotted(SALES, 100));
  expect(all.map(said)).toStrictEqual([
    [
      ["0", "units", "BDI"],
      ["0", "revenue", "BDI"],
    ],
    [
      ["50", "units", "BDI"],
      ["1,000", "revenue", "BDI"],
    ],
    [
      ["200", "units", "BDI"],
      ["4,000", "revenue", "BDI"],
    ],
  ]);
  const unnamed = { ...AGAINST, y: { col: 5, header: "" } };
  const [first] = pointTargets(unnamed, SALES, plotted(SALES, 100)).all;
  expect(said(first!)[1]).toStrictEqual(["0", m.column_unnamed({ number: 6 }), "SPAN"]);
});

test("the nearest point within HIT_RADIUS of a pointer is the target, and none further", () => {
  const { under } = pointTargets(AGAINST, SALES, plotted(SALES, 100));
  // The points stand at (0, 100), (25, 75) and (100, 0).
  expect(under(null, 25, 75)).toBe(1);
  expect(under(null, 25 + HIT_RADIUS, 75)).toBe(1);
  expect(under(null, 25 + HIT_RADIUS + 1, 75)).toBeUndefined();
  expect(under(null, 100, 0)).toBe(2);
  // Two points HIT_RADIUS apart: the pointer goes to the nearer.
  const pair = sampleOf([0, 10], [0, 0]);
  const near = pointTargets(AGAINST, pair, plotted(pair, HIT_RADIUS)).under;
  expect(near(null, HIT_RADIUS / 2 + 1, HIT_RADIUS)).toBe(1);
  expect(near(null, HIT_RADIUS / 2 - 1, HIT_RADIUS)).toBe(0);
});

test("targets gives a drawing's marks for its plot's kind, and none for a tally of another", () => {
  const complete = { coverage: { rows: 3, total: 3, complete: true } };
  const groups: GroupsTally = { t: "groups", plot: ROWS, ...complete, ...REGIONS };
  const sample: SampleTally = { t: "sample", plot: AGAINST, ...complete, ...SALES };
  expect(targets(ROWS, groups, bars(ROWS, REGIONS, TALL)).all).toHaveLength(3);
  expect(targets(SHARES, groups, pie(SHARES, REGIONS)).all).toHaveLength(2);
  expect(targets(AGAINST, sample, scatter(SALES)).all).toHaveLength(3);
  expect(targets(ROWS, sample, bars(ROWS, REGIONS, TALL))).toBe(NONE);
});

/** A window's room, and a box's size, in px. */
const ROOM = { w: 400, h: 300 };
const SIZE = { w: 80, h: 24 };

/** A pointer's point at `x`, `y`, as an anchor. */
const at = (x: number, y: number): DOMRect => new DOMRect(x, y);

test("the box stands TIP_OFFSET right of its anchor, centred on it, moved back TIP_EDGE inside the room, or at its edge where it is larger", () => {
  expect(stood(at(100, 100), SIZE, ROOM)).toStrictEqual({ x: 100 + TIP_OFFSET, y: 88 });
  expect(stood(at(0, 290), SIZE, ROOM)).toStrictEqual({ x: TIP_OFFSET, y: 272 });
  expect(stood(at(0, 0), SIZE, ROOM)).toStrictEqual({ x: TIP_OFFSET, y: TIP_EDGE });
  expect(stood(at(100, 100), { w: 500, h: 400 }, ROOM)).toStrictEqual({
    x: TIP_EDGE,
    y: TIP_EDGE,
  });
});

test("the box stands TIP_OFFSET left of its anchor where the room has too little on its right, and at the room's edge where neither side has enough", () => {
  expect(stood(at(390, 100), SIZE, ROOM).x).toBe(390 - TIP_OFFSET - SIZE.w);
  const mark = new DOMRect(300, 90, 30, 20);
  expect(stood(mark, SIZE, ROOM).x).toBe(mark.left - TIP_OFFSET - SIZE.w);
  expect(stood(at(60, 100), SIZE, { w: 150, h: ROOM.h }).x).toBe(TIP_EDGE);
});

/** Lays `at` out as a page would: `rect` is its box, and the sizes it reads. */
function laidOut(at: HTMLElement, rect: DOMRect): void {
  Object.defineProperties(at, {
    getBoundingClientRect: { value: () => rect },
    clientWidth: { value: rect.width },
    clientHeight: { value: rect.height },
    offsetWidth: { value: rect.width },
    offsetHeight: { value: rect.height },
  });
}

/**
 * A tooltip over a plot of `drawn`, in a window ROOM px big at the page's
 * corner, whose box measures SIZE, showing `of`'s marks.
 */
function over(
  drawn: HTMLElement,
  of: (box: HTMLElement) => Targets,
): { tip: Tooltip; plot: HTMLElement } {
  const within = el("div");
  const plot = el("div");
  plot.append(drawn);
  within.append(plot);
  document.body.append(within);
  laidOut(within, new DOMRect(0, 0, ROOM.w, ROOM.h));
  const tip = new Tooltip(plot, within, "tip");
  within.append(tip.box);
  laidOut(tip.box, new DOMRect(0, 0, SIZE.w, SIZE.h));
  tip.show(of(drawn));
  return { tip, plot };
}

/** Moves a pointer to `x`, `y` over `at`, which bubbles to the plot. */
function moveTo(at: Element, x: number, y: number): void {
  at.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
}

/** Whether the box shows, what it says, and where it stands. */
const shown = (tip: Tooltip): [boolean, string | null, string] => [
  !tip.box.hidden,
  tip.box.querySelector(".chart-tip-words")?.textContent ?? null,
  `${tip.box.style.left} ${tip.box.style.top}`,
];

/** Which rows wear the cursor. */
const cursors = (): boolean[] =>
  [...document.querySelectorAll(".chart-bar-row")].map((row) => row.classList.contains("cursor"));

test("the pointer over a bar's row shows the box right of the pointer with the bar's value strong, under its key, and the row wears the cursor", () => {
  const { tip } = over(bars(ROWS, REGIONS, TALL), (box) => barTargets(ROWS, REGIONS, box));
  const rows = [...document.querySelectorAll(".chart-bar-row")];
  moveTo(rows[1]!.querySelector(".chart-bar-label")!, 100, 50);
  expect(shown(tip)).toStrictEqual([true, "812 South", `${100 + TIP_OFFSET}px 38px`]);
  expect(tip.box.querySelector("strong.chart-tip-value")?.textContent).toBe("812");
  expect(tip.box.querySelector(".chart-tip-label .from-file")?.textContent).toBe("South");
  const key = tip.box.querySelector<HTMLElement>(".chart-tip-key");
  expect(key?.style.getPropertyValue("--key")).toBe("var(--accent)");
  expect(tip.box.getAttribute("role")).toBe("tooltip");
  expect(cursors()).toStrictEqual([false, true, false]);
  moveTo(rows[0]!, 120, 20);
  expect(shown(tip)).toStrictEqual([true, "1,204 North", `${120 + TIP_OFFSET}px 8px`]);
  expect(cursors()).toStrictEqual([true, false, false]);
});

test("the box stands left of the pointer at the window's right edge, back inside at its foot, and goes, emptied, as the pointer leaves the rows or the plot", () => {
  const { tip, plot } = over(bars(ROWS, REGIONS, TALL), (box) => barTargets(ROWS, REGIONS, box));
  const [row] = document.querySelectorAll(".chart-bar-row");
  moveTo(row!, ROOM.w - 1, ROOM.h - 1);
  const left = ROOM.w - 1 - TIP_OFFSET - SIZE.w;
  expect(shown(tip)[2]).toBe(`${left}px ${ROOM.h - SIZE.h - TIP_EDGE}px`);
  moveTo(plot, 10, 10);
  expect([shown(tip)[0], ...cursors()]).toStrictEqual([false, false, false, false]);
  moveTo(row!, 10, 10);
  plot.dispatchEvent(new PointerEvent("pointerleave"));
  expect([...shown(tip).slice(0, 2), ...cursors()]).toStrictEqual([false, "", false, false, false]);
});
