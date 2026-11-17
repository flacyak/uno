/**
 * @fileoverview Which smoke groups UNO_SMOKE_ONLY picks. See src/main/smoke/groups.ts.
 */

import { expect, test } from "vite-plus/test";

import { GROUPS, SCHEDULE, selected } from "@main/smoke/groups";

const TABLE = [
  { name: "open", starts: true },
  { name: "default-input" },
  { name: "sources" },
  { name: "charts", starts: true },
  { name: "chart-keys" },
  { name: "chart-moves" },
  { name: "chart-pie", starts: true },
  { name: "chart-refresh", needs: ["sources"] },
];
const names = (only: string | undefined) => selected(TABLE, only).map((g) => g.name);

test("unset or empty, every group runs in order", () => {
  expect(names(undefined)).toEqual(TABLE.map((g) => g.name));
  expect(names("")).toEqual(TABLE.map((g) => g.name));
});

test("a group runs with the groups it leans on, back to the start of its run", () => {
  expect(names("chart-moves")).toEqual(["charts", "chart-keys", "chart-moves"]);
  expect(names("sources")).toEqual(["open", "default-input", "sources"]);
});

test("a group that starts afresh runs alone", () => {
  expect(names("chart-pie")).toEqual(["chart-pie"]);
  expect(names("charts")).toEqual(["charts"]);
});

test("a group that reads what another run left runs that run too", () => {
  expect(names("chart-refresh")).toEqual([
    "open",
    "default-input",
    "sources",
    "chart-pie",
    "chart-refresh",
  ]);
});

test("several names run in the usual order, each once", () => {
  expect(names(" chart-pie, chart-keys ,charts")).toEqual(["charts", "chart-keys", "chart-pie"]);
});

test("a name no group has is refused, so a typo cannot pass as a run of nothing", () => {
  expect(() => names("chart")).toThrow("UNO_SMOKE_ONLY names no smoke group: chart");
});

test("the real table names each group once, and the schedule's group starts afresh", () => {
  const all = GROUPS.map((g) => g.name);
  expect(new Set(all).size).toBe(all.length);
  expect(GROUPS.find((g) => g.name === SCHEDULE)?.starts).toBe(true);
  for (const g of GROUPS) for (const needed of g.needs ?? []) expect(all).toContain(needed);
});

test("in the real table, the schedule runs alone and chart-refresh brings refresh's run", () => {
  expect(selected(GROUPS, SCHEDULE).map((g) => g.name)).toEqual([SCHEDULE]);
  const refresh = selected(GROUPS, "chart-refresh").map((g) => g.name);
  expect(refresh).toContain("refresh");
  expect(refresh).toContain("chart-states");
  expect(refresh.at(-1)).toBe("chart-refresh");
});
