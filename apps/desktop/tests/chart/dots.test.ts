/**
 * @fileoverview A dot plot's rows: a dot per value at its rows, sum or mean,
 * on one axis that need not start at zero.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { DotsPlot } from "@document";
import type { GroupsTally, MeanTally } from "@engine";
import { dots } from "@renderer/chart/dots";
import { BAR_GAP, BAR_THICK, rowsIn } from "@renderer/chart/rows";

const CARRIER = { col: 0, header: "carrier" };
const DAYS = { col: 1, header: "days" };
const MEANS: DotsPlot = { t: "dots", by: CARRIER, of: DAYS, measure: "mean" };
const COVERAGE = { rows: 10, total: 10, complete: true };
const NONE = { values: 0, rows: 0, sum: 0 };
/** A plot that holds four rows, and the axis's. */
const HEIGHT = 5 * (BAR_THICK + BAR_GAP) + 20;

/** A tally of means, each value with `numbers` numbers that add to `sum`. */
function means(groups: Array<[string, number, number]>): MeanTally {
  return {
    t: "mean",
    plot: MEANS,
    coverage: COVERAGE,
    groups: groups.map(([value, sum, numbers]) => ({ value, rows: numbers + 1, sum, numbers })),
    others: NONE,
    below: NONE,
    rest: { rows: 0, sum: 0 },
    skipped: { blank: 0, unparsed: 0 },
  };
}

/** The share of the axis each row's dot stands at, or none for a row with no dot. */
const shares = (drawn: HTMLElement) =>
  [...drawn.querySelectorAll<HTMLElement>(".chart-dot-track")].map((track) =>
    track.querySelector(".chart-dot") === null
      ? undefined
      : Number(track.style.getPropertyValue("--at")),
  );

test("a dot stands at its mean on an axis from the tick at or under the least to the tick at or over the most, not from zero", () => {
  const drawn = dots(
    MEANS,
    means([
      ["Acme", 6.8, 2],
      ["Bolt", 3.1, 1],
      ["Crane", 3.2, 1],
    ]),
    HEIGHT,
  );
  // 3.4, 3.1 and 3.2 on an axis of 3.1 to 3.4.
  expect(shares(drawn).map((at) => Math.round(at! * 3))).toStrictEqual([3, 0, 1]);
});

test("the axis's labels stand under the rows, a gridline at each tick runs through every row, and a hairline runs to each dot", () => {
  const drawn = dots(
    MEANS,
    means([
      ["Acme", 6.8, 2],
      ["Bolt", 3.1, 1],
      ["None", 0, 0],
    ]),
    HEIGHT,
  );
  const ticks = [...drawn.querySelectorAll<HTMLElement>(".chart-dots-axis .chart-tick")];
  expect(ticks.map((t) => t.textContent)).toStrictEqual(["3.1", "3.2", "3.3", "3.4"]);
  const at = (marks: Iterable<HTMLElement>) =>
    [...marks].map((mark) => Math.round(Number(mark.style.getPropertyValue("--at")) * 3));
  expect(at(ticks)).toStrictEqual([0, 1, 2, 3]);
  for (const track of drawn.querySelectorAll<HTMLElement>(".chart-dot-track")) {
    expect(at(track.querySelectorAll<HTMLElement>(".chart-dot-line"))).toStrictEqual([0, 1, 2, 3]);
  }
  expect(drawn.querySelectorAll(".chart-dot-guide")).toHaveLength(2);
  expect(drawn.lastElementChild?.classList.contains("chart-dots-axis")).toBe(true);
});

test("a value with no number has no dot and says so, and the rows a plot cannot hold are left out, a line counting them", () => {
  const many = means([
    ["a", 5, 1],
    ["b", 4, 1],
    ["c", 3, 1],
    ["d", 2, 1],
    ["e", 1, 1],
    ["none", 0, 0],
  ]);
  const drawn = dots(
    MEANS,
    { ...many, groups: [many.groups[5]!, ...many.groups.slice(0, 5)] },
    HEIGHT,
  );
  const rows = [...drawn.querySelectorAll(".chart-bar-row:has(.chart-dot-track)")];
  // The axis's labels take a row, and the line of what is left out another.
  expect(rows).toHaveLength(rowsIn(HEIGHT) - 2);
  expect(shares(drawn)[0]).toBeUndefined();
  expect(rows[0]!.querySelector(".chart-dots-none")?.textContent).toBe("no numbers");
  expect(drawn.querySelector(".chart-bars-line")?.textContent).toBe("+3 more · 6 rows");
});

test("dots of rows or a sum stand at them, and one value's axis runs from zero past twice it", () => {
  const tally: GroupsTally = {
    ...means([]),
    t: "groups",
    groups: [{ value: "Acme", rows: 4, sum: 12 }],
  };
  expect(shares(dots({ t: "dots", by: CARRIER }, tally, HEIGHT))).toStrictEqual([0.5]);
  const summed = dots({ t: "dots", by: CARRIER, of: DAYS, measure: "sum" }, tally, HEIGHT);
  // 12 reaches to 24, which ticks of 10 take in by 30.
  expect(shares(summed)).toStrictEqual([0.4]);
});
