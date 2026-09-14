// The engine answers whatever its port hands it.
//
// The renderer on the other end of the port is treated as a web page: what it
// posts is data it made up, and an engine that throws on one request takes
// every tab down with it. So each probe here is a message something other
// than the client would send -- not an object, a kind that does not exist, a
// field of the wrong type -- and the claim is the same for all of them: the
// handler never throws, nothing is left rejecting with nobody to catch it, and
// a request that carried a usable id gets exactly one reply.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { BAND_ROWS, ROWS_AT_MOST, serve } from "../../src/engine/index.ts";
import type { Port, Reply, Request } from "../../src/engine/index.ts";
import { sources } from "../../src/plugin/index.ts";
import { blobProvider } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { FIXTURE, TINY, connect } from "./harness.ts";

/** A port whose far end is this test: it posts anything, and reads every reply. */
interface Probe {
  replies: Reply[];
  /** What `listen`'s callback threw, which in a worker would have ended the engine. */
  thrown: unknown[];
  send(msg: unknown): void;
}

function probe(): Probe {
  const replies: Reply[] = [];
  const thrown: unknown[] = [];
  let handler: ((msg: Request) => void) | undefined;
  const port: Port<Request, Reply> = {
    post: (msg) => replies.push(msg),
    listen: (fn) => {
      handler = fn;
    },
    close: () => {},
  };
  serve(port, sources([diskProvider(), blobProvider()]), TINY);
  return {
    replies,
    thrown,
    send(msg) {
      try {
        handler!(msg as Request);
      } catch (err) {
        thrown.push(err);
      }
    },
  };
}

/** Rejections nobody caught while a test ran. */
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

/** settle waits long enough for a rejection nobody caught to be reported. */
async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function withId(replies: Reply[], id: number): Reply[] {
  return replies.filter((r) => "id" in r && r.id === id);
}

const NOT_OBJECTS: unknown[] = [null, undefined, 42, "open", [], () => {}, true];

test("a message that is not an object is answered or ignored, never thrown on", async () => {
  const p = probe();
  for (const msg of NOT_OBJECTS) p.send(msg);
  await settle();
  expect(p.thrown).toEqual([]);
  expect(unhandled).toEqual([]);
});

test("an object with no kind, or a kind that does not exist, is refused by id", async () => {
  const p = probe();
  p.send({});
  p.send({ id: 1 });
  p.send({ t: "explode", id: 2 });
  p.send({ t: 3, id: 3 });
  await settle();
  expect(p.thrown).toEqual([]);
  expect(unhandled).toEqual([]);
  for (const id of [1, 2, 3]) {
    const got = withId(p.replies, id);
    expect(got.map((r) => r.t)).toEqual(["error"]);
  }
});

test("a request of a known kind with its fields wrong is refused, once, by id", async () => {
  const p = probe();
  const bad: unknown[] = [
    { t: "open", id: 10 },
    { t: "open", id: 11, ref: null },
    { t: "open", id: 12, ref: { name: "x.csv", path: { nested: true } } },
    { t: "open", id: 13, ref: 7 },
    { t: "rows", id: 14, source: "nope", first: 0, count: 10 },
    { t: "rows", id: 15 },
    { t: "edit", id: 16, source: "nope" },
    { t: "find", id: 17, source: "nope" },
    { t: "list", id: 18, path: { a: 1 } },
    { t: "stat", id: 19, path: 42 },
    { t: "stat", id: 20 },
    { t: "peek", id: 21 },
    { t: "peek", id: 22, ref: "sales-q3.csv" },
    { t: "peek", id: 23, ref: { name: "x", path: "/definitely/not/here.csv" } },
    { t: "connections", id: 24 },
    { t: "profiles", id: 25 },
    { t: "try", id: 26, connection: null },
    { t: "save", id: 27 },
    { t: "save", id: 28, place: null, limit: 0 },
    { t: "relink", id: 29 },
    { t: "append", id: 30, source: "nope", parts: "x" },
    { t: "undo", id: 31 },
    { t: "redo", id: 32, source: 5 },
    { t: "remove", id: 33, source: ["a"] },
  ];
  for (const msg of bad) p.send(msg);
  await settle();
  expect(p.thrown).toEqual([]);
  expect(unhandled).toEqual([]);
  for (let id = 10; id <= 33; id++) {
    const got = withId(p.replies, id);
    expect(
      got.map((r) => r.t),
      `request ${id}`,
    ).toEqual(["error"]);
  }
});

test("an id that is not a number still gets a reply it can be matched by, and never a throw", async () => {
  const p = probe();
  p.send({ t: "stat", id: "seven", path: FIXTURE });
  p.send({ t: "stat", id: -1, path: FIXTURE });
  p.send({ t: "stat", id: 0, path: FIXTURE });
  p.send({ t: "stat", id: 2 ** 53, path: FIXTURE });
  p.send({ t: "stat", id: Number.NaN, path: FIXTURE });
  p.send({ t: "stat", id: null, path: FIXTURE });
  await settle();
  expect(p.thrown).toEqual([]);
  expect(unhandled).toEqual([]);
  expect(p.replies.length).toBe(6);
});

test("rows asked with a count that is not a count are refused or answered empty", async () => {
  const p = probe();
  p.send({ t: "open", id: 1, ref: { name: "sales-q3.csv", path: FIXTURE } });
  await settle(20);
  const opened = withId(p.replies, 1);
  expect(opened.map((r) => r.t)).toEqual(["opened"]);
  const source = opened[0]!.t === "opened" ? opened[0]!.added.showing : "";
  p.send({ t: "mode", transform: true });
  const bad: unknown[] = [
    { t: "rows", id: 2, source, first: -1, count: 10 },
    { t: "rows", id: 3, source, first: 0, count: 1e12 },
    { t: "rows", id: 4, source, first: 0, count: Number.NaN },
    { t: "rows", id: 5, source, first: "0", count: "10" },
    { t: "rows", id: 6, source, first: 1e15, count: 10 },
    { t: "rows", id: 7, source, first: 0, count: -5 },
    { t: "rows", id: 8, source, first: 0.5, count: 2.5 },
    {
      t: "find",
      id: 9,
      source,
      find: { col: 999, from: 0, dir: 1, match: { t: "text", text: "a" } },
    },
    {
      t: "find",
      id: 10,
      source,
      find: { col: -1, from: 0, dir: 1, match: { t: "text", text: "a" } },
    },
    { t: "find", id: 11, source, find: { col: 0, from: 0, dir: 1, match: { t: "regex" } } },
    {
      t: "find",
      id: 12,
      source,
      find: { col: 0, from: Number.NaN, dir: 1, match: { t: "unparsed" } },
    },
    { t: "find", id: 13, source, find: null },
    {
      t: "find",
      id: 14,
      source,
      find: { col: 0, from: 0, dir: 3, match: { t: "text", text: "a" } },
    },
    { t: "edit", id: 15, source, edit: { op: "set", row: 1e9, col: 0, now: "x" } },
    { t: "edit", id: 16, source, edit: { op: "set", row: 0, col: 999, now: "x" } },
    { t: "edit", id: 17, source, edit: { op: "bind", row: 0, col: 0, now: "=nope + 1" } },
    { t: "edit", id: 18, source, edit: null },
    { t: "edit", id: 19, source, edit: { op: "nonsense", row: 0, col: 0, now: "x" } },
    { t: "save", id: 20, place: { source, cells: null, at: "" }, limit: 1e9 },
    { t: "save", id: 21, place: { source, cells: [], at: "" }, limit: "big" },
    { t: "remove", id: 22, source },
    { t: "relink", id: 23, source, ref: { name: "gone.csv", path: "/no/such/file.csv" } },
    {
      t: "append",
      id: 24,
      source,
      parts: Array.from({ length: 10_000 }, (_, i) => ({
        name: `p${i}.csv`,
        path: `/no/p${i}.csv`,
      })),
    },
    { t: "rows", id: 25, source, first: 0, count: 3 },
  ];
  for (const msg of bad) p.send(msg);
  await settle(50);
  expect(p.thrown).toEqual([]);
  expect(unhandled).toEqual([]);
  for (let id = 2; id <= 25; id++) {
    const got = withId(p.replies, id);
    expect(got.length, `request ${id}: ${JSON.stringify(got.map((r) => r.t))}`).toBe(1);
  }
  p.send({ t: "close" });
  await settle(20);
});

test("a peek at what is not a table is refused or answered, and reads a bounded front", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-engine-hostile-"));
  const empty = join(dir, "empty.csv");
  const one = join(dir, "one.csv");
  const binary = join(dir, "binary.csv");
  await writeFile(empty, "");
  await writeFile(one, "a");
  await writeFile(binary, new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 256)));
  const p = probe();
  const odd: unknown[] = [
    { t: "peek", id: 1, ref: { name: "empty.csv", path: empty } },
    { t: "peek", id: 2, ref: { name: "one.csv", path: one } },
    { t: "peek", id: 3, ref: { name: "binary.csv", path: binary } },
    { t: "peek", id: 4, ref: { name: "dir", path: dir } },
    { t: "peek", id: 5, ref: { name: "nul.csv", path: `${dir}/a\0b.csv` } },
    { t: "peek", id: 6, ref: { name: "sales-q3.csv", path: FIXTURE } },
    { t: "peek", id: 7, ref: { name: "sales-q3.csv", blob: new Blob([new Uint8Array(1 << 20)]) } },
    { t: "peek", id: 8, ref: { name: "parts", parts: [], header: "first" } },
    { t: "peek", id: 9, ref: { name: "parts", parts: null, header: "first" } },
  ];
  for (const msg of odd) p.send(msg);
  await settle(50);
  expect(p.thrown).toEqual([]);
  expect(unhandled).toEqual([]);
  for (let id = 1; id <= 9; id++) {
    const got = withId(p.replies, id);
    expect(got.length, `request ${id}: ${JSON.stringify(got.map((r) => r.t))}`).toBe(1);
  }
  const whole = withId(p.replies, 6)[0]!;
  expect(whole.t).toBe("peeked");
});

test("replies land by id, so a fast answer overtaking a slow one settles the right promise", async () => {
  const { engine, done } = connect(TINY);
  const slow = engine.open({ name: "sales-q3.csv", path: FIXTURE });
  const fast = engine.stat(FIXTURE);
  const entry = await fast;
  expect(entry.bytes).toBeGreaterThan(0);
  const { sources: opened } = await slow;
  expect(opened.length).toBe(1);
  done();
});

test("rows asked for more than a band are refused, so no reply holds a file whole", async () => {
  expect(BAND_ROWS).toBeLessThanOrEqual(ROWS_AT_MOST);
  const p = probe();
  p.send({ t: "open", id: 1, ref: { name: "sales-q3.csv", path: FIXTURE } });
  await settle(20);
  const opened = withId(p.replies, 1)[0]!;
  const source = opened.t === "opened" ? opened.added.showing : "";
  p.send({ t: "rows", id: 2, source, first: 0, count: ROWS_AT_MOST });
  p.send({ t: "rows", id: 3, source, first: 0, count: ROWS_AT_MOST + 1 });
  p.send({ t: "rows", id: 4, source, first: 0, count: 1e12 });
  p.send({ t: "rows", id: 5, source, first: 0, count: "2" });
  await settle(50);
  expect(p.thrown).toEqual([]);
  expect(unhandled).toEqual([]);
  const band = withId(p.replies, 2)[0]!;
  expect(band.t === "rows" && band.rows.length).toBe(ROWS_AT_MOST);
  for (const id of [3, 4, 5]) {
    expect(
      withId(p.replies, id).map((r) => r.t),
      `request ${id}`,
    ).toEqual(["error"]);
  }
  p.send({ t: "close" });
  await settle(20);
});

test("requests after a close are refused by id, and a second close is quiet", async () => {
  const p = probe();
  p.send({ t: "close" });
  p.send({ t: "close" });
  p.send({ t: "open", id: 1, ref: { name: "sales-q3.csv", path: FIXTURE } });
  p.send({ t: "rows", id: 2, source: "sales-q3", first: 0, count: 10 });
  p.send({ t: "stat", id: 3, path: FIXTURE });
  p.send({ t: "mode", transform: "yes" });
  p.send({ t: "mode" });
  await settle(20);
  expect(p.thrown).toEqual([]);
  expect(unhandled).toEqual([]);
  expect(withId(p.replies, 1).map((r) => r.t)).toEqual(["error"]);
  expect(withId(p.replies, 2).map((r) => r.t)).toEqual(["error"]);
  expect(withId(p.replies, 3).length).toBe(1);
});
