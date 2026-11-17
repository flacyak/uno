/**
 * @fileoverview Which smoke groups a change touches. See src/main/smoke/affected.ts
 * and smoke-groups.json.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { GROUPS } from "@main/smoke/groups";
import { affected, covering } from "@main/smoke/affected";
import type { SmokeMap } from "@main/smoke/affected";
import MAP from "../smoke-groups.json" with { type: "json" };

const map: SmokeMap = MAP;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("a chart file runs the chart groups, a test file runs nothing, a script runs everything", () => {
  expect(covering(map, "apps/desktop/src/renderer/chart/pie.ts")).toContain("chart-pie");
  expect(covering(map, "apps/desktop/src/renderer/chart/pie.ts")).not.toContain("sidebar");
  expect(covering(map, "apps/desktop/tests/chart/pie.test.ts")).toBe("none");
  expect(covering(map, "apps/desktop/scripts/build.js")).toBe("all");
  expect(covering(map, "core/src/engine/rows.ts")).toBe("all");
});

test("a group's own smoke file runs that group, and the shared smoke files run everything", () => {
  expect(covering(map, "apps/desktop/src/main/smoke/sidebar.ts")).toEqual(["sidebar"]);
  expect(covering(map, "apps/desktop/src/main/smoke/refresh.ts")).toEqual([
    "refresh",
    "chart-refresh",
  ]);
  expect(covering(map, "apps/desktop/src/main/smoke/index.ts")).toBe("all");
});

test("the groups of several paths are joined, 'all' wins, and an unmapped path runs everything and is named", () => {
  expect(
    affected(map, ["core/src/tally/time.ts", "apps/desktop/src/main/smoke/sidebar.ts"]).groups,
  ).toEqual(expect.arrayContaining(["charts", "chart-schedule", "sidebar"]));
  expect(affected(map, ["docs/chart.gif", "apps/desktop/tests/find.test.ts"])).toEqual({
    groups: [],
    unmapped: [],
  });
  expect(affected(map, ["core/src/tally/time.ts", "paths.js"]).groups).toBe("all");
  expect(affected(map, ["somewhere/new.ts"])).toEqual({
    groups: "all",
    unmapped: ["somewhere/new.ts"],
  });
});

test("an entry that is a word other than all or none is refused where it is read", () => {
  expect(() => covering({ "core/**": "every" }, "core/src/go/index.ts")).toThrow(
    'smoke-groups.json maps core/** to "every", not groups, "all" or "none"',
  );
});

test("every group the map names is a group, so a renamed group cannot leave a stale entry", () => {
  const names = new Set(GROUPS.map((g) => g.name));
  for (const [glob, covers] of Object.entries(map)) {
    if (covers === "all" || covers === "none") continue;
    for (const g of covers) expect(names.has(g), `${glob} names ${g}`).toBe(true);
  }
});

test("every tracked file has an entry, so no change falls through to a full run by accident", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((p) => p !== "");
  const gaps = tracked.filter((p) => covering(map, p) === undefined);
  expect(gaps).toEqual([]);
});
