// A workspace meets its connections: every S3 source a .uno names is matched
// to a connection covering it, and one nothing covers is not read at all.
//
// A .uno travels, and the person opening one did not choose the buckets in it.
// What is under test is that such a source opens missing, keeps its edits,
// says which bucket it wants connecting, and costs the bucket nothing -- not a
// HEAD -- until a connection to it has been made. Then it is read like any
// other.

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
import { HOME_REGION } from "../store/regions.ts";
import { BUCKET, KEYS, bucket, etagOf } from "../store/standin.ts";
import type { Bucket } from "../store/standin.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import { FIXTURE, connect, indexed, openOne } from "./harness.ts";

let b: Bucket;
beforeAll(async () => {
  b = await bucket();
});
afterAll(() => b.close());

const OBJECT = `s3://${BUCKET}/2025/sales-q3.csv`;
/** The same object, written the way a browser shows it. */
const HTTPS = `https://${BUCKET}.s3.amazonaws.com/2025/sales-q3.csv`;

const env = {
  AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
  AWS_REGION: HOME_REGION,
  AWS_PROFILE: undefined,
  AWS_CONFIG_FILE: "/nonexistent/config",
  AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/credentials",
};

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

/** An engine the way the desktop wires one: connections in a folder, signed and guarded by them. */
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
 * workspace saves a .uno somebody else made: the fixture off the disk and the
 * object in the bucket, one edit on the object, in an engine that knows no
 * connections at all -- the way a colleague's machine would have written it.
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

// The task's own sentence.
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
    // The work done through it is still there, waiting for the file.
    expect(remote.opened.edits).toHaveLength(1);
    // And the source on disk opened as ever.
    await indexed(sourceNamed(sources, "local.csv"));
    expect(sourceNamed(sources, "local.csv").progress.rows).toBe(ROWS);

    // Accepting is making the connection. Then the source reads like any other.
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

// A connection to another folder of the bucket is not a connection to this one.
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

// The guard reads addresses the way the handler does, so a .uno written with
// the https form of an address is held to it as well.
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
  // The longest prefix, which is the connection the handler signs with.
  expect(meet(OBJECT)).toEqual({ through: EXPORTS.id });
  expect(meet(`s3://${BUCKET}/2024/x.csv`)).toEqual({ through: "whole" });
  // With none, the folder the object is in is what connecting it offers to cover.
  const none = connectionMeeting(() => []);
  expect(none(OBJECT)).toEqual({ unconnected: { bucket: BUCKET, prefix: "2025/" } });
  expect(none(`s3://${BUCKET}/top.csv`)).toEqual({ unconnected: { bucket: BUCKET, prefix: "" } });
});

// Connecting the bucket is what the source waited for, so it stops waiting
// whether or not its object is still there. One that has gone is missing like
// any other, and says why -- not "connect acme-exports" once more, which would
// send the person round the same form for a connection they already have.
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

    // Before it is connected, a failed read is only a failed read, and the
    // source is still waiting for its bucket.
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

// 3.1: which bytes a source was read as, and the connection it came through,
// go into the save, so the next open can tell a rewrite from the file the log
// was made against. A source that could not be read writes back what it was
// given, and a file on disk has neither.
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
  // Saved on a machine that had the connection, opened on one that does not.
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
