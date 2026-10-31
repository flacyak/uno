/**
 * @fileoverview A workspace's charts over the real engine. The model mirrors
 * the records the engine holds.
 */

import { expect, test } from "vite-plus/test";

import { connect } from "@core-tests/engine/harness";
import { readContainer } from "@document";
import type { Chart } from "@document";
import type { SourceRef } from "@engine";
import { Workspace } from "@renderer/workspace";
import { BARS } from "./charted.ts";
import { FIXTURE } from "./smoke/dom-harness.ts";

/** The sales export alone. */
const FILE: SourceRef = { name: "sales-q3.csv", path: FIXTURE };

/** Opens `ref` in a workspace of its own, runs `use` over it, and closes it. */
async function opened(ref: SourceRef, use: (w: Workspace) => Promise<void>): Promise<void> {
  const ignore = (): void => {};
  const w = await Workspace.open(ref, connect().engine, "", ignore, ignore);
  try {
    await use(w);
  } finally {
    w.close();
  }
}

/** The charts the engine writes for `w`, read back from its save. */
async function savedCharts(w: Workspace): Promise<readonly Chart[] | undefined> {
  return readContainer("q3.uno", await w.bytes({ row: 0, col: 0 }, "")).charts;
}

test("adding a chart goes through the engine", async () => {
  await opened(FILE, async (w) => {
    const first = await w.charts.add(BARS);
    const second = await w.charts.add({ ...BARS, title: "Second" });
    expect(w.charts.all).toStrictEqual([first, second]);
    expect(await savedCharts(w)).toStrictEqual([first, second]);
  });
});
