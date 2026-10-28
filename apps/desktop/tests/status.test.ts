/**
 * @fileoverview The status bar's clock: the time the showing tab's source has
 * taken while it indexes, that time with the row count once it is complete, and
 * nothing for a tab with no file behind it or with no workspace open. Its cell
 * line names the chosen column and row, or whichever of them the sheet has.
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, expect, test } from "vite-plus/test";

import type { Grid } from "@renderer/grid";
import { strategy } from "@renderer/input";
import { StatusBar } from "@renderer/shell/status";
import type { Tab, Workspace } from "@renderer/workspace";
import { bodyMarkup } from "./markup.ts";

/** The fixture's row count in the plan's example, and a time it took. */
const ROWS = 1_204_000;
const TOOK_MS = 2_400;

/** A tab whose index has run for `elapsedMs` over `rows`, complete or not. */
function tab(elapsedMs: number, complete: boolean, missing = false): Tab {
  const progress = { complete, rows: ROWS, elapsedMs };
  return { missing, source: { progress } } as unknown as Tab;
}

function workspace(active: Tab): Workspace {
  return { active, mode: "view", status: () => "" } as unknown as Workspace;
}

let bar: StatusBar;
beforeEach(() => {
  document.body.innerHTML = bodyMarkup();
  bar = new StatusBar(
    () => {},
    () => {},
    { toggleMode() {}, toggleSidebar() {}, togglePanel() {} },
  );
});

/** painted paints the bar for `w` with no grid, and returns the clock's text. */
function painted(w: Workspace | undefined): string {
  bar.paint(w, undefined, strategy("default"), { sidebar: false, panel: false });
  return document.querySelector("#status-clock")?.textContent ?? "";
}

test("while the source indexes, the clock counts the time in tenths of a second", () => {
  expect(painted(workspace(tab(0, false)))).toBe("0.0 s");
  expect(painted(workspace(tab(TOOK_MS, false)))).toBe("2.4 s");
  expect(painted(workspace(tab(12_340, false)))).toBe("12.3 s");
});

test("complete, the clock reads the time the source took and its rows", () => {
  expect(painted(workspace(tab(TOOK_MS, true)))).toBe("2.4 s · 1,204,000 rows");
});

test("the clock is empty with no workspace, and for a tab with no file behind it", () => {
  expect(painted(undefined)).toBe("");
  expect(painted(workspace(tab(0, true, true)))).toBe("");
});

/**
 * cellLine paints the bar for a complete sheet of `rows` rows under
 * `headers`, with its first cell chosen, and returns the cell line's text.
 */
function cellLine(headers: readonly string[], rows: number): string {
  const columns = headers.map((header) => ({ header }));
  const w = {
    active: tab(TOOK_MS, true),
    mode: "view",
    status: () => "",
    rows: { columns, rows: () => rows },
  };
  const grid = { selection: () => ({ row: 0, col: 0 }), editing: () => false };
  bar.paint(w as unknown as Workspace, grid as unknown as Grid, strategy("default"), {
    sidebar: false,
    panel: false,
  });
  return document.querySelector("#status-cell")?.textContent ?? "";
}

test("the cell line names the chosen column and row, or whichever the sheet has", () => {
  expect(cellLine(["region"], ROWS)).toBe("region · row 1");
  expect(cellLine(["region"], 0)).toBe("region");
  // A JSON Lines file whose keys have not been met yet has rows and no columns.
  expect(cellLine([], ROWS)).toBe("row 1");
});
