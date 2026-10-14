// The time a tab's source took to index, by the engine's clock: it grows
// while the index runs, stays once the index is complete, and a source
// reopened from a .uno has the time of its reopen.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { diskProvider } from "@uno/grid/store/node";

import { FIXTURE, TINY, slowed } from "../../grid/tests/engine/harness.ts";
import { Workspace } from "../src/renderer/workspace.ts";
import type { Tab } from "../src/renderer/workspace.ts";
import { engineOver } from "./bucket-engine.ts";

/**
 * Milliseconds added before each read, so the fixture indexes over several
 * progress replies rather than one.
 */
const READ_MS = 10;
/** How often a wait looks at the index. */
const LOOK_MS = 5;
/** How long the wall clock runs on after the index completes. */
const LATER_MS = 50;

const REF = { name: "sales-q3.csv", path: FIXTURE };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "uno-elapsed-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** indexed resolves once the tab's index is complete. */
async function indexed(tab: Tab): Promise<void> {
  while (!tab.source.progress.complete) await sleep(LOOK_MS);
}

test("a tab's time grows while its source indexes, stays once complete, and a reopen has its own", async () => {
  // The showing tab's time at every change the workspace reports.
  const seen: number[] = [];
  let showing: Tab | undefined;
  const w = await Workspace.open(
    REF,
    engineOver([slowed(diskProvider(), READ_MS)], TINY),
    "",
    () => {
      if (showing !== undefined) seen.push(showing.elapsedMs);
    },
    () => {},
  );
  try {
    const tab = w.active;
    showing = tab;
    const atOpen = tab.elapsedMs;
    expect(tab.source.progress.complete, "the open returns with the index running").toBe(false);
    expect(atOpen).toBeGreaterThan(0);

    await indexed(tab);
    const took = tab.elapsedMs;
    expect(seen.length).toBeGreaterThanOrEqual(3);
    let last = atOpen;
    for (const ms of seen) {
      expect(ms).toBeGreaterThanOrEqual(last);
      last = ms;
    }
    expect(last).toBe(took);
    expect(took).toBeGreaterThan(atOpen);

    // Complete, the time stays while the wall clock runs on.
    await sleep(LATER_MS);
    expect(tab.elapsedMs).toBe(took);

    // Saved and reopened over a plain disk engine, the tab has the time the
    // reopen took, far short of the slowed open's.
    const uno = join(dir, "sales-q3.uno");
    await writeFile(uno, await w.bytes({ row: 0, col: 0 }, uno));
    const started = performance.now();
    const again = await Workspace.open(
      { name: "sales-q3.uno", path: uno },
      engineOver([diskProvider()]),
      uno,
      () => {},
      () => {},
    );
    try {
      const reopened = again.active;
      await indexed(reopened);
      const wall = performance.now() - started;
      expect(reopened.elapsedMs).toBeGreaterThan(0);
      expect(reopened.elapsedMs).toBeLessThanOrEqual(wall);
      expect(reopened.elapsedMs).toBeLessThan(took);
    } finally {
      again.close();
    }
  } finally {
    w.close();
  }
});
