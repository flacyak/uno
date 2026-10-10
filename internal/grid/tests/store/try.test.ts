// tryConnection: a connection tried before it is saved. It finds the bucket's
// region and counts a page of the prefix, signed the way the connection signs
// in.
//
// A working connection comes back with its region and counts. A failing one
// is refused with the reason: access denied, or a missing bucket.

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

// Through the engine. The connection list stays empty after a try.
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
