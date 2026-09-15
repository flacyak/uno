// A connection tried before it is saved: its bucket's region, and a page of its
// prefix, asked the way it signs in.
//
// What is under test is what the connect screen shows. A connection that works
// comes back with its region filled in and a count of what its prefix holds.
// One that does not is refused in words that say why -- 403, no such bucket --
// so the screen can say exactly that and save nothing.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import type { Connection } from "../../src/library/index.ts";
import { connectionsIn } from "../../src/store/index.ts";
import { connectionAuth, diskProvider, nodeStore } from "../../src/store/node.ts";
import { tryConnection } from "../../src/store/s3.ts";
import { bytes, connect } from "../engine/harness.ts";
import { HOME_REGION } from "./regions.ts";
import { BUCKET, bucket, keysOnly } from "./standin.ts";
import type { Bucket } from "./standin.ts";

let b: Bucket;
beforeAll(async () => {
  b = await bucket(
    undefined,
    HOME_REGION,
    new Map([
      ["shop/2025/orders-10.csv", bytes],
      ["shop/2025/orders-11.csv", bytes],
      ["shop/2025/refunds/r-10.csv", bytes],
      ["shop/2025/summary.pdf", bytes],
      ["shop/2024/orders-12.csv", bytes],
    ]),
  );
});
afterAll(() => b.close());

/** The machine's keys, which say us-east-1, while the bucket is in eu-west-1. */
const env = keysOnly("us-east-1");

function draft(over: Partial<Connection> = {}): Connection {
  return {
    format: 1,
    id: "acme-exports",
    name: "acme-exports",
    provider: "s3",
    bucket: BUCKET,
    prefix: "shop/2025/",
    auth: { mode: "machine" },
    created: undefined,
    modified: undefined,
    ...over,
  };
}

function options(machine = env) {
  const auth = connectionAuth(machine);
  return { sign: (c: Connection) => auth.of(c), endpoint: b.endpoint };
}

test("a connection that works comes back with its region and what its prefix holds", async () => {
  const tried = await tryConnection(draft(), options());
  expect(tried).toEqual({
    connection: { ...draft(), region: HOME_REGION },
    folders: 1,
    files: 3,
    more: false,
  });
});

test("the whole bucket, from its root", async () => {
  const tried = await tryConnection(draft({ prefix: "" }), options());
  expect({ folders: tried.folders, files: tried.files }).toEqual({ folders: 1, files: 0 });
});

// The refusals the screen shows, each in the words of what stopped it.
test("a 403 says access was denied, and to whom", async () => {
  const wrong = { ...env, AWS_SECRET_ACCESS_KEY: "not it" };
  await expect(tryConnection(draft(), options(wrong))).rejects.toThrow(
    "s3://acme-exports: access denied · acme-exports (this machine's AWS credentials) cannot reach that bucket",
  );
});

test("a bucket that is not there says so", async () => {
  await expect(tryConnection(draft({ bucket: "acme-nowhere" }), options())).rejects.toThrow(
    "s3://acme-nowhere: no such bucket",
  );
});

// Through the engine, the way the connect screen asks: nothing is saved by
// trying, so the engine's connections are the same list afterwards.
test("the engine tries a connection and keeps nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-try-"));
  const kept = connectionsIn(nodeStore(), dir);
  const auth = connectionAuth(env);
  const { engine, done } = connect(undefined, [diskProvider()], {
    connections: kept,
    test: (c) => tryConnection(c, { sign: (x) => auth.of(x), endpoint: b.endpoint }),
  });
  try {
    const tried = await engine.tryConnection(draft());
    expect(tried.connection.region).toBe(HOME_REGION);
    expect(tried.files).toBe(3);
    expect((await engine.connections()).connections).toEqual([]);
  } finally {
    done();
  }
});

test("an engine whose platform connects to nothing says so", async () => {
  const { engine, done } = connect();
  try {
    await expect(engine.tryConnection(draft())).rejects.toThrow(
      "this engine cannot try a connection · its platform connects to nothing",
    );
  } finally {
    done();
  }
});
