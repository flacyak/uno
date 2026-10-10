// `engine.connections`: connections are read from a folder on each call, so
// one saved after the engine started is returned. Dates and unknown keys
// cross the channel intact.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { parseConnection } from "../../src/library/index.ts";
import { connectionsIn, saveConnection } from "../../src/store/index.ts";
import { nodeStore } from "../../src/store/node.ts";
import { connect, saidIn } from "./harness.ts";

const ACME = fileURLToPath(new URL("../testdata/acme-exports.unof", import.meta.url));

async function acme() {
  return parseConnection("acme-exports.unof", await readFile(ACME, "utf8"));
}

test("a connection saved after the engine started is one it answers with", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-engine-connections-"));
  const store = nodeStore();
  const { engine, done } = connect(undefined, undefined, connectionsIn(store, dir));
  try {
    expect(await engine.connections()).toEqual({ connections: [], failed: [] });

    const saved = await saveConnection(store, dir, await acme());
    const { connections } = await engine.connections();
    expect(connections).toEqual([saved]);
    // A Date crosses the channel as a Date.
    expect(connections[0]!.modified).toBeInstanceOf(Date);
  } finally {
    done();
  }
});

test("the keys this build does not know cross the channel with the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-engine-connections-"));
  const store = nodeStore();
  await saveConnection(store, dir, { ...(await acme()), extra: new Map([["ttl", 900]]) });

  const { engine, done } = connect(undefined, undefined, connectionsIn(store, dir));
  try {
    const { connections } = await engine.connections();
    expect(connections[0]!.extra).toEqual(new Map([["ttl", 900]]));
  } finally {
    done();
  }
});

test("a file that will not read is said, and the rest still load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-engine-connections-"));
  const store = nodeStore();
  await saveConnection(store, dir, await acme());
  await writeFile(join(dir, "broken.unof"), "{not json");

  const { engine, done } = connect(undefined, undefined, connectionsIn(store, dir));
  try {
    const { connections, failed } = await engine.connections();
    expect(connections.map((c) => c.id)).toEqual(["acme-exports"]);
    expect(failed).toHaveLength(1);
    expect(saidIn(failed[0])).toMatch(/^broken\.unof is not a readable \.unof file/);
  } finally {
    done();
  }
});

test("an engine with nowhere to keep connections refuses by name", async () => {
  const { engine, done } = connect();
  try {
    await expect(engine.connections()).rejects.toThrow(
      "this engine keeps no connections · its platform gave it nowhere to read them from",
    );
  } finally {
    done();
  }
});
