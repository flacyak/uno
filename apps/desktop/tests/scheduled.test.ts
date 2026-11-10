/**
 * @fileoverview A scheduled check of a file: one stat, which reads nothing
 * while the file is as it was read, a rewritten file read again with the
 * workspace left clean, and one with unsaved cell edits held until a save
 * records them, where a column edit holds nothing; one of an object whose
 * bucket is not connected asks the bucket nothing. Runs over the real engine
 * and the disk.
 */

import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";

import { connect } from "@core-tests/engine/harness";
import { BUCKET } from "@core-tests/store/standin";
import { Engine } from "@engine";
import { Workspace } from "@renderer/workspace";
import { diskProvider } from "@store/node";
import type { Meeting } from "@store/s3";
import { SALES, unoOf } from "./charted.ts";

/** A one-column export, and the row a rewrite adds to it. */
const SAVED = "a\n1\n";
const ADDED = "2\n";

/** An object in a bucket no connection covers. */
const UNCOVERED = `s3://${BUCKET}/sales-q3.csv`;

const relink = vi.spyOn(Engine.prototype, "relink");
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "uno-scheduled-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Opens a workspace of a new file named `name`, its index complete. */
async function indexed(name: string): Promise<Workspace> {
  const path = join(dir, name);
  await writeFile(path, SAVED);
  const ignore = (): void => {};
  const w = await Workspace.open(
    { name, path },
    connect(undefined, [diskProvider()]).engine,
    "",
    ignore,
    ignore,
  );
  await vi.waitUntil(() => w.active.source.progress.complete);
  return w;
}

test("a check of a file as it was read reads nothing, and one of a rewritten file reads it again", async () => {
  const w = await indexed("same.csv");
  relink.mockClear();
  expect(await w.refresh(w.active.id)).toStrictEqual({ t: "same" });
  expect(relink).not.toHaveBeenCalled();

  await appendFile(w.active.link!.path, ADDED);
  expect(await w.refresh(w.active.id)).toStrictEqual({ t: "read" });
  expect(relink).toHaveBeenCalledOnce();
  expect(w.rows.rows()).toBe(2);
  expect(w.dirty).toBe(false);
  w.close();
});

test("a rewritten file with unsaved cell edits is held, and read once a save records them", async () => {
  const w = await indexed("edited.csv");
  w.transform();
  await w.set(0, 0, "9");
  await appendFile(w.active.link!.path, ADDED);
  relink.mockClear();
  expect(await w.refresh(w.active.id)).toStrictEqual({ t: "held", edits: 1 });
  expect(relink).not.toHaveBeenCalled();

  w.saved(join(dir, "edited.uno"));
  expect(await w.refresh(w.active.id)).toStrictEqual({ t: "read" });
  w.close();
});

test("a rewritten file with an unsaved column edit alone is read again", async () => {
  const w = await indexed("bound.csv");
  w.transform();
  await w.bind(w.active, 0, "1");
  await appendFile(w.active.link!.path, ADDED);
  expect(await w.refresh(w.active.id)).toStrictEqual({ t: "read" });
  w.close();
});

test("a check of a source waiting on its bucket asks the bucket nothing", async () => {
  const uno = join(dir, "uncovered.uno");
  await writeFile(uno, unoOf([], [], UNCOVERED));
  const connections = { all: [], load: () => Promise.resolve({ connections: [], failed: [] }) };
  // The object's bucket is outside every connection, as before the person connects it.
  const meet = (path: string): Meeting | undefined =>
    path === UNCOVERED ? { unconnected: { bucket: BUCKET, prefix: "" } } : undefined;
  const engine = connect(undefined, [diskProvider()], { connections, meet }).engine;
  const ignore = (): void => {};
  const w = await Workspace.open({ name: "uncovered.uno", path: uno }, engine, uno, ignore, ignore);
  const stat = vi.spyOn(engine, "stat");
  expect(await w.refresh(SALES)).toStrictEqual({ t: "waiting", why: "unconnected" });
  expect(stat).not.toHaveBeenCalled();
  w.close();
});
