// A .uno's S3 sources are matched to the connections that cover them. A source
// outside every connection opens as missing, keeps its edits, names the bucket
// to connect, and leaves the bucket alone until a connection is made.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { readContainer } from "../../src/document/index.ts";
import type { SourceHandle } from "../../src/engine/index.ts";
import type { Connection } from "../../src/library/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { connectionsIn, saveConnection } from "../../src/store/index.ts";
import { connectionSigning, diskProvider, nodeStore } from "../../src/store/node.ts";
import { connectionMeeting, s3Provider } from "../../src/store/s3.ts";
import { BUCKET, bucket, etagOf, keysOnly } from "../store/standin.ts";
import type { Bucket } from "../store/standin.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import { FIXTURE, connect, indexed, openOne } from "./harness.ts";

let b: Bucket;
beforeAll(async () => {
  b = await bucket();
});
afterAll(() => b.close());

const OBJECT = `s3://${BUCKET}/2025/sales-q3.csv`;
/** The same object as an https URL. */
const HTTPS = `https://${BUCKET}.s3.amazonaws.com/2025/sales-q3.csv`;

const env = keysOnly();

const EXPORTS: Connection = {
  format: 1,
  id: "acme-exports",
  name: "ACME exports",
  provider: "s3",
  bucket: BUCKET,
  prefix: "2025/",
  auth: { mode: "machine" },
  created: undefined,
  modified: undefined,
};

/**
 * An engine wired like the desktop: connections in a folder, with S3 signed
 * and gated by them.
 */
async function desktop(saved: Connection[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "uno-meets-"));
  const store = nodeStore();
  for (const c of saved) await saveConnection(store, dir, c);
  const kept = connectionsIn(store, dir);
  const s3 = s3Provider({
    credentials: connectionSigning(() => kept.all, env),
    endpoint: b.endpoint,
  });
  const wired = connect(undefined, [diskProvider(), s3], {
    connections: kept,
    meet: connectionMeeting(() => kept.all),
  });
  return { ...wired, store, dir };
}

/**
 * workspace saves a .uno with the fixture from disk and the object at `path`,
 * with one edit on the object, from an engine whose saved connections are
 * empty.
 */
async function workspace(path = OBJECT): Promise<string> {
  const { engine, done } = await desktop();
  try {
    const local = await openOne(engine, { name: "local.csv", path: FIXTURE });
    const remote = await openOne(engine, { name: "sales-q3.csv", path });
    await Promise.all([indexed(local), indexed(remote)]);
    engine.mode(true);
    await remote.edit({ op: Op.Set, row: 1, col: UNITS, now: "986" });
    const uno = await engine.save(
      { source: remote.id, cells: [{ source: remote.id, row: 0, col: 0 }], at: "" },
      1 << 20,
    );
    const file = join(await mkdtemp(join(tmpdir(), "uno-meets-uno-")), "q4-close.uno");
    await writeFile(file, uno);
    return file;
  } finally {
    done();
  }
}

function sourceNamed(sources: SourceHandle[], name: string): SourceHandle {
  return sources.find((s) => s.opened.name === name)!;
}

test("the stand-in bucket sees zero requests before the person accepts", async () => {
  const file = await workspace();
  const { engine, done, store, dir } = await desktop();
  try {
    const before = b.seen.length;
    const { sources } = await engine.open({ name: "q4-close.uno", path: file });
    const remote = sourceNamed(sources, "sales-q3.csv");
    expect(b.seen.length, "nothing was asked of the bucket").toBe(before);
    expect(remote.opened.link).toEqual({
      path: OBJECT,
      missing: { t: "bucket-unconnected", container: "q4-close.uno", bucket: BUCKET },
      connect: { bucket: BUCKET, prefix: "2025/" },
    });
    // The edit is kept.
    expect(remote.opened.edits).toHaveLength(1);
    // The disk source opens as usual.
    await indexed(sourceNamed(sources, "local.csv"));
    expect(sourceNamed(sources, "local.csv").progress.rows).toBe(ROWS);

    // Once the connection is saved and reloaded, a relink reads the object.
    await saveConnection(store, dir, EXPORTS);
    await engine.connections();
    const back = await engine.relink(remote, { name: "sales-q3.csv", path: OBJECT });
    await indexed(back);
    expect(b.seen.length).toBeGreaterThan(before);
    expect(back.progress.rows).toBe(ROWS);
    expect(back.opened.edits).toHaveLength(1);
    expect(
      (await back.rows(1, 1)).raws[0]?.[UNITS] ?? (await back.rows(1, 1)).rows[0]![UNITS],
    ).toBe("986");
  } finally {
    done();
  }
});

test("a source a connection already covers opens and reads as it always did", async () => {
  const file = await workspace();
  const { engine, done } = await desktop([EXPORTS]);
  try {
    const { sources } = await engine.open({ name: "q4-close.uno", path: file });
    const remote = sourceNamed(sources, "sales-q3.csv");
    expect(remote.opened.link?.missing).toBeUndefined();
    await indexed(remote);
    expect(remote.progress.rows).toBe(ROWS);
  } finally {
    done();
  }
});

test("a connection to another folder of the bucket does not cover it", async () => {
  const file = await workspace();
  const { engine, done } = await desktop([{ ...EXPORTS, prefix: "2024/" }]);
  try {
    const before = b.seen.length;
    const { sources } = await engine.open({ name: "q4-close.uno", path: file });
    expect(sourceNamed(sources, "sales-q3.csv").opened.link?.connect).toEqual({
      bucket: BUCKET,
      prefix: "2025/",
    });
    expect(b.seen.length).toBe(before);
  } finally {
    done();
  }
});

test("an object named by its https address is guarded the same way", async () => {
  const file = await workspace(HTTPS);
  const { engine, done } = await desktop();
  try {
    const before = b.seen.length;
    const { sources } = await engine.open({ name: "q4-close.uno", path: file });
    expect(sourceNamed(sources, "sales-q3.csv").opened.link?.connect).toEqual({
      bucket: BUCKET,
      prefix: "2025/",
    });
    expect(b.seen.length).toBe(before);
  } finally {
    done();
  }
});

test("a path on disk meets no connection, and an object meets the one it is read through", () => {
  const meet = connectionMeeting(() => [EXPORTS, { ...EXPORTS, id: "whole", prefix: "" }]);
  expect(meet(FIXTURE)).toBeUndefined();
  // The longest matching prefix wins.
  expect(meet(OBJECT)).toEqual({ through: EXPORTS.id });
  expect(meet(`s3://${BUCKET}/2024/x.csv`)).toEqual({ through: "whole" });
  // An unmatched object has its folder offered as the prefix to connect.
  const none = connectionMeeting(() => []);
  expect(none(OBJECT)).toEqual({ unconnected: { bucket: BUCKET, prefix: "2025/" } });
  expect(none(`s3://${BUCKET}/top.csv`)).toEqual({ unconnected: { bucket: BUCKET, prefix: "" } });
});

// Once the bucket is connected, a source whose object is gone is missing
// with a plain reason, and stops asking for a connection.
test("a source whose object has gone stops waiting once its bucket is connected, and says why", async () => {
  const key = "2025/gone.csv";
  const gone = `s3://${BUCKET}/${key}`;
  b.objects.set(key, b.objects.get("2025/sales-q3.csv")!);
  let file: string;
  try {
    file = await workspace(gone);
  } finally {
    b.objects.delete(key);
  }
  const { engine, done, store, dir } = await desktop();
  try {
    const { sources } = await engine.open({ name: "q4-close.uno", path: file });
    const remote = sourceNamed(sources, "sales-q3.csv");
    const at = { name: "sales-q3.csv", path: gone };

    // Before the connection, a relink fails and the source keeps waiting.
    await expect(engine.relink(remote, at)).rejects.toThrow(
      `${gone}: no such object in that bucket`,
    );

    await saveConnection(store, dir, EXPORTS);
    await engine.connections();
    const now = await engine.relink(remote, at);
    expect(now.opened.link).toEqual({
      path: gone,
      missing: { t: "text", text: `${gone}: no such object in that bucket` },
    });
    expect(now.opened.edits).toHaveLength(1);
  } finally {
    done();
  }
});

// A save records each S3 source's version and connection. A disk source is
// recorded with both left undefined.
test("a save records the version an object was read as and the connection it came through", async () => {
  const { engine, done } = await desktop([EXPORTS]);
  try {
    const file = await workspace();
    const { sources } = await engine.open({ name: "q4-close.uno", path: file });
    await Promise.all(sources.map((s) => indexed(s)));
    const remote = sourceNamed(sources, "sales-q3.csv");
    const version = etagOf(b.objects.get("2025/sales-q3.csv")!);
    expect(remote.opened.link).toEqual({ path: OBJECT, version });

    const saved = readContainer(
      "q4-close.uno",
      await engine.save({ source: remote.id, cells: [], at: file }, 1 << 20),
    );
    const byName = new Map(saved.sources.map((s) => [s.name, s]));
    expect(byName.get("sales-q3.csv")).toMatchObject({ version, connection: EXPORTS.id });
    expect(byName.get("local.csv")!.version).toBeUndefined();
    expect(byName.get("local.csv")!.connection).toBeUndefined();
  } finally {
    done();
  }
});

test("a source waiting for its bucket saves the version and connection it was opened with", async () => {
  // Saved on a machine that had the connection, opened on one missing it.
  const had = await desktop([EXPORTS]);
  let file: string;
  try {
    const first = await workspace();
    const { sources } = await had.engine.open({ name: "q4-close.uno", path: first });
    await Promise.all(sources.map((s) => indexed(s)));
    file = join(await mkdtemp(join(tmpdir(), "uno-meets-pinned-")), "q4-close.uno");
    await writeFile(
      file,
      await had.engine.save({ source: sources[0]!.id, cells: [], at: file }, 1 << 20),
    );
  } finally {
    had.done();
  }
  const { engine, done } = await desktop();
  try {
    const { sources } = await engine.open({ name: "q4-close.uno", path: file });
    const waiting = sourceNamed(sources, "sales-q3.csv");
    expect(waiting.opened.link?.connect).toBeDefined();
    const again = readContainer(
      "q4-close.uno",
      await engine.save({ source: waiting.id, cells: [], at: file }, 1 << 20),
    );
    const was = readContainer("q4-close.uno", await readFile(file));
    const pick = (d: typeof was) => d.sources.find((s) => s.name === "sales-q3.csv")!;
    expect(pick(again).version).toBe(pick(was).version);
    expect(pick(again).connection).toBe(EXPORTS.id);
  } finally {
    done();
  }
});
