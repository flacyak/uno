/**
 * @fileoverview A re-point at another file or an append marks the workspace
 * unsaved, and a reload of the tab's own file leaves it clean, however the
 * file changed: the next save records what it read. Runs over the real engine
 * and the disk.
 */

import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { connect, multiProviders } from "@core-tests/engine/harness";
import { FIXTURE } from "@core-tests/testdata/sales-q3";
import { PART_FIXTURES } from "@core-tests/testdata/sales-q3-parts";
import type { SourceRef } from "@engine";
import { Workspace } from "@renderer/workspace";
import type { SingleRef } from "@store";

/** A one-column export as it was saved, and the same export a row longer. */
const SAVED = "a\n1\n";
const GROWN = "a\n1\n2\n";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "uno-relink-unsaved-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The file at `path`, under its own name. */
function at(path: string): SingleRef {
  return { name: basename(path), path };
}

/** Opens `ref` in a workspace of its own, runs `use` over it, and closes it. */
async function opened(ref: SourceRef, use: (w: Workspace) => Promise<void>): Promise<void> {
  const ignore = (): void => {};
  const { engine } = connect(undefined, multiProviders());
  const w = await Workspace.open(ref, engine, "", ignore, ignore);
  try {
    await use(w);
  } finally {
    w.close();
  }
}

/** Reloads the showing tab as Reload does, and returns whether the workspace is unsaved. */
async function reload(w: Workspace): Promise<boolean> {
  await w.relink(w.active, at(w.active.link!.path));
  return w.dirty;
}

test("a re-point at a copy of the file marks the workspace unsaved", async () => {
  const copy = join(dir, basename(FIXTURE));
  await copyFile(FIXTURE, copy);
  await opened(at(FIXTURE), async (w) => {
    await w.relink(w.active, at(copy));
    expect(w.dirty).toBe(true);
  });
});

test("an append marks the workspace unsaved", async () => {
  const first = { ref: at(PART_FIXTURES[0]!) };
  await opened({ name: "sales-q3", parts: [first], header: "first" }, async (w) => {
    await w.append(w.active, [at(PART_FIXTURES[1]!)]);
    expect(w.dirty).toBe(true);
  });
});

test("a reload of the tab's own file leaves the workspace clean, however the file changed", async () => {
  const csv = join(dir, "grown.csv");
  const uno = join(dir, "grown.uno");
  await writeFile(csv, SAVED);
  await opened(at(csv), async (w) => writeFile(uno, await w.bytes({ row: 0, col: 0 }, uno)));

  await opened(at(uno), async (w) => {
    expect(await reload(w), "reopened as saved").toBe(false);
    await writeFile(csv, GROWN);
    expect(await reload(w), "grown while open").toBe(false);
  });

  // Reopened, the tab reads the grown file, which changed since the save, and
  // the tab says so until a reload. The next save records what the reload read.
  await opened(at(uno), async (w) => {
    expect(w.active.trouble).toBeDefined();
    expect(await reload(w), "grown since the save").toBe(false);
    expect(w.active.trouble).toBeUndefined();
    await writeFile(uno, await w.bytes({ row: 0, col: 0 }, uno));
  });
  await opened(at(uno), async (w) => expect(w.active.trouble, "after a save").toBeUndefined());
});
