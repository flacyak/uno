/**
 * @fileoverview The order a chart of bars keeps once a person moves a bar.
 */

import { expect, test } from "vite-plus/test";

import { GROUPS_SENT } from "@engine";
import { movedOrder } from "@renderer/chart/moving";

/** Four regions drawn largest first, none moved yet. */
const DRAWN = ["West", "East", "South", "North"];

test.each<[string, string[], string[], number, number, string[]]>([
  ["down one keeps the bar above it in place", DRAWN, [], 0, 1, ["East", "West"]],
  ["to the top keeps it alone", DRAWN, [], 3, 0, ["North"]],
  ["to the bottom keeps every bar", DRAWN, [], 0, 3, ["East", "South", "North", "West"]],
  [
    "below those moved before keeps them",
    ["North", "West", "East", "South"],
    ["North", "West"],
    3,
    1,
    ["North", "South", "West"],
  ],
  [
    "a moved one moved again stays among them",
    ["North", "West", "East", "South"],
    ["North", "West"],
    1,
    0,
    ["West", "North"],
  ],
  ["past the ends stays at the ends", DRAWN, [], 1, 9, ["West", "South", "North", "East"]],
  ["a value moved before that draws no bar stays, after", DRAWN, ["Gone"], 1, 0, ["East", "Gone"]],
])("a bar moved %s", (_, drawn, before, from, to, order) => {
  expect(movedOrder(drawn, before, from, to)).toStrictEqual(order);
});

test("the order holds no more values than a tally sends", () => {
  const drawn = Array.from({ length: GROUPS_SENT }, (_, i) => `${i}`);
  expect(movedOrder(drawn, ["Gone"], 0, GROUPS_SENT - 1)).toHaveLength(GROUPS_SENT);
});
