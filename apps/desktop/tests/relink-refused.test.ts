/**
 * @fileoverview A tab re-pointed at a file its edits cannot replay on is
 * refused, and keeps its own rows. The engine counts the new file's rows
 * before the replay refuses it, and none of that count may reach the tab.
 *
 * Runs over the real engine and the disk.
 */

import { expect, test } from "vite-plus/test";

import { connect, indexed } from "@core-tests/engine/harness";
import { FIXTURE, REGION, ROWS } from "@core-tests/testdata/sales-q3";
import { PART_FIXTURES, PART_NAMES } from "@core-tests/testdata/sales-q3-parts";
import { m } from "@paraglide/messages";
import { Workspace } from "@renderer/workspace";

/** A row in the export's last third, past the end of its first part. */
const DEEP_ROW = 4000;

test("a re-point the edits cannot replay on is refused, and the tab keeps its own rows", async () => {
  const w = await Workspace.open(
    { name: "sales-q3.csv", path: FIXTURE },
    connect().engine,
    FIXTURE,
    () => {},
    () => {},
  );
  try {
    const tab = w.active;
    await indexed(tab.source);
    w.transform();
    await w.set(DEEP_ROW, REGION, "x");

    // The export's first third, which ends long before the edited row.
    const part = { name: PART_NAMES[0]!, path: PART_FIXTURES[0]! };
    await expect(w.relink(tab, part)).rejects.toThrow(/replaying edits/);

    expect(w.active).toBe(tab);
    expect(w.status()).toContain(m.rows_count({ count: ROWS }));
    expect((await tab.source.rows(DEEP_ROW, 1)).rows[0]![REGION]).toBe("x");
  } finally {
    w.close();
  }
});
