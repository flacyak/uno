// Connections kept in a folder, loaded and saved through the store.
//
// One broken file costs that connection only, two files with one id are
// reported, and a refused save leaves the folder as it was.

import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { parseConnection } from "../../src/library/index.ts";
import type { Connection } from "../../src/library/index.ts";
import { loadConnections, saveConnection } from "../../src/store/index.ts";
import { nodeStore } from "../../src/store/node.ts";

const TESTDATA = fileURLToPath(new URL("../testdata/", import.meta.url));

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "uno-connections-"));
}

/** The desktop fixture as a connection, under the given id. */
async function acme(id = "acme-exports"): Promise<Connection> {
  const text = await readFile(join(TESTDATA, "acme-exports.unof"), "utf8");
  return { ...parseConnection("acme-exports.unof", text), id, name: id };
}

test("a saved connection reads back out of the folder", async () => {
  const store = nodeStore();
  const dir = await scratch();

  const saved = await saveConnection(store, dir, await acme());
  expect(await readdir(dir)).toEqual(["acme-exports.unof"]);

  const { connections, failed } = await loadConnections(store, dir);
  expect(failed).toEqual([]);
  expect(connections).toEqual([saved]);
});

test("one broken file costs one connection, and the rest load", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await saveConnection(store, dir, await acme("acme-exports"));
  await saveConnection(store, dir, await acme("finance-drop"));
  await writeFile(join(dir, "broken.unof"), "{not json");
  await copyFile(join(TESTDATA, "unit-margin.unof"), join(dir, "unit-margin.unof"));
  await writeFile(join(dir, "notes.txt"), "not a connection");

  const { connections, failed } = await loadConnections(store, dir);
  expect(connections.map((c) => c.id)).toEqual(["acme-exports", "finance-drop"]);
  expect(failed.map((e) => e.message.split(" ")[0])).toEqual(["broken.unof", "unit-margin.unof"]);
  expect(failed[1]!.message).toContain("it belongs in formulas/");
});

test("they come back in id order, whatever the files are called", async () => {
  const store = nodeStore();
  const dir = await scratch();

  for (const id of ["zeta", "alpha", "mu"]) await saveConnection(store, dir, await acme(id));

  const { connections } = await loadConnections(store, dir);
  expect(connections.map((c) => c.id)).toEqual(["alpha", "mu", "zeta"]);
});

// The file named after the id loads. Other files with the same id are
// failures.
test("a second file with an id already loaded is a failure naming both", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await saveConnection(store, dir, await acme());
  await copyFile(join(dir, "acme-exports.unof"), join(dir, "acme-copy.unof"));
  await copyFile(join(dir, "acme-exports.unof"), join(dir, "zz-acme.unof"));

  const { connections, failed } = await loadConnections(store, dir);
  expect(connections).toHaveLength(1);
  expect(failed.map((e) => e.message)).toEqual([
    'acme-copy.unof is connection "acme-exports" too, and acme-exports.unof already is · rename one of their ids',
    'zz-acme.unof is connection "acme-exports" too, and acme-exports.unof already is · rename one of their ids',
  ]);
});

test("with no file named after the id, the first in name order loads", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await saveConnection(store, dir, await acme());
  await copyFile(join(dir, "acme-exports.unof"), join(dir, "b.unof"));
  await copyFile(join(dir, "acme-exports.unof"), join(dir, "a.unof"));
  await rm(join(dir, "acme-exports.unof"));

  const { failed } = await loadConnections(store, dir);
  expect(failed.map((e) => e.message.split(" ")[0])).toEqual(["b.unof"]);
});

test("a folder that does not exist yet is no connections rather than a failure", async () => {
  const dir = join(await scratch(), "connections");
  expect(await loadConnections(nodeStore(), dir)).toEqual({ connections: [], failed: [] });
});

test("a save stamps the times, and a second save keeps when it was created", async () => {
  const store = nodeStore();
  const dir = await scratch();
  const fresh = { ...(await acme()), created: undefined, modified: undefined };

  const first = await saveConnection(store, dir, fresh);
  expect(first.created).toBeInstanceOf(Date);
  expect(first.modified).toEqual(first.created);

  const second = await saveConnection(store, dir, { ...first, name: "ACME, renamed" });
  expect(second.created).toEqual(first.created);
  const { connections } = await loadConnections(store, dir);
  expect(connections[0]!.name).toBe("ACME, renamed");
});

// The secret is refused before anything is written.
test("a connection holding a key is refused, and the file already there is untouched", async () => {
  const store = nodeStore();
  const dir = await scratch();
  const c = await saveConnection(store, dir, await acme());
  const before = await readFile(join(dir, "acme-exports.unof"), "utf8");

  const leaky: Connection = {
    ...c,
    extra: new Map([["aws_secret_access_key", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"]]),
  };
  await expect(saveConnection(store, dir, leaky)).rejects.toThrow(/looks like a secret/);
  expect(await readFile(join(dir, "acme-exports.unof"), "utf8")).toBe(before);
  expect(await readdir(dir)).toEqual(["acme-exports.unof"]);
});

test("an id that would name a path is refused before it is joined to one", async () => {
  const store = nodeStore();
  const dir = await scratch();
  await expect(saveConnection(store, dir, await acme("../escape"))).rejects.toThrow(
    'connection id "../escape" may not start with a dot',
  );
  expect(await readdir(dir)).toEqual([]);
});
