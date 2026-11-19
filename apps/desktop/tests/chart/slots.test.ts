/**
 * @fileoverview A stacked chart's series keep their slots, and so their
 * colours, from one tally to the next, by the series design's four rules.
 */

import { expect, test } from "vite-plus/test";

import type { StackTally } from "@engine";
import { inSlots, slotted } from "@renderer/chart/slots";

test.each<[string, string[], string[], string[]]>([
  [
    "the first tally takes the slots in rank order",
    [],
    ["web", "direct", "partner"],
    ["web", "direct", "partner"],
  ],
  [
    "a series that stays keeps its slot as the ranks change",
    ["web", "direct", "partner"],
    ["partner", "web", "direct"],
    ["web", "direct", "partner"],
  ],
  [
    "one that enters takes the slot one that left freed",
    ["web", "direct", "partner"],
    ["mail", "partner", "web"],
    ["web", "mail", "partner"],
  ],
  [
    "two that enter take the freed slots in rank order",
    ["a", "b", "c", "d"],
    ["d", "y", "a", "x"],
    ["a", "y", "x", "d"],
  ],
  [
    "where fewer are shown, those above the gap move down",
    ["web", "direct", "partner", "mail"],
    ["mail", "web"],
    ["web", "mail"],
  ],
  [
    "where more are shown, the new ones follow",
    ["web", "direct"],
    ["fair", "direct", "web", "shop"],
    ["web", "direct", "fair", "shop"],
  ],
  ["none shown leaves none", ["web"], [], []],
])("%s", (_, was, now, slots) => {
  expect(slotted(was, now)).toStrictEqual(slots);
});

test("a tally in slots has its series and each value's cells in the slots' order", () => {
  const cell = (rows: number) => ({ rows, sum: 0 });
  const tally: StackTally = {
    t: "stack",
    plot: { t: "stack", by: { col: 1, header: "region" }, split: { col: 3, header: "channel" } },
    coverage: { rows: 6, total: 6, complete: true },
    series: ["partner", "web"],
    values: [{ value: "East", cells: [cell(3), cell(2)], other: cell(1), total: cell(6) }],
    others: { values: 0, rows: 0, sum: 0 },
    below: { values: 0, rows: 0, sum: 0 },
    rest: { rows: 0, sum: 0 },
    unsplit: 0,
    skipped: { blank: 0, unparsed: 0 },
  };
  const slots = inSlots(tally, ["web", "partner"]);
  expect(slots.series).toStrictEqual(["web", "partner"]);
  expect(slots.values[0]!.cells).toStrictEqual([cell(2), cell(3)]);
  expect(slots.values[0]!.other).toStrictEqual(cell(1));
});
