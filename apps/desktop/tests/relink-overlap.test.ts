/**
 * @fileoverview A tab reloaded and, before the reload is answered, re-pointed
 * or removed ends as the second answer leaves it. That answer comes back for
 * a tab the reload already replaced. The engine answers in the order asked,
 * so the race needs no timing.
 *
 * Runs over the real engine and the disk.
 */

import { expect, test } from "vite-plus/test";

import { connect } from "@core-tests/engine/harness";
import { FIXTURE, REGION } from "@core-tests/testdata/sales-q3";
import { PART_FIXTURES, PART_NAMES, PART_ROWS } from "@core-tests/testdata/sales-q3-parts";
import { Workspace } from "@renderer/workspace";

const WHOLE = { name: "sales-q3.csv", path: FIXTURE };
const PART = { name: PART_NAMES[0]!, path: PART_FIXTURES[0]! };

/** A cell on the first third's last row, selected between the two answers. */
const PICKED = { row: PART_ROWS - 1, col: REGION };

/** How long the last file gets to be indexed, in a run that shares the machine. */
const INDEX_MS = 2_000;

function open(): Promise<Workspace> {
  return Workspace.open(
    WHOLE,
    connect().engine,
    FIXTURE,
    () => {},
    () => {},
  );
}

test("a reload and a re-point of one tab at once leave the showing tab reading to the end", async () => {
  const w = await open();
  try {
    // Reload, then the export's first third picked before the reload is answered.
    const reloaded = w.relink(w.active, WHOLE);
    const pointed = w.relink(w.active, PART);
    (await reloaded).cell = PICKED;
    await expect
      .poll(() => w.active.source.progress, { timeout: INDEX_MS })
      .toMatchObject({ complete: true, rows: PART_ROWS });
    expect(w.rows.readable?.()).toBe(PART_ROWS);
    expect(w.active).toBe(await pointed);
    expect(w.active.cell).toEqual(PICKED);
  } finally {
    w.close();
  }
});

test("a tab removed before its reload is answered leaves the list", async () => {
  const w = await open();
  try {
    await w.add(PART);
    const [, removed] = await Promise.all([w.relink(w.active, WHOLE), w.remove(w.active)]);
    expect(w.sources.map((t) => t.name)).toEqual([PART.name]);
    expect(w.active.name).toBe(PART.name);
    expect(removed).toBe(true);
  } finally {
    w.close();
  }
});
