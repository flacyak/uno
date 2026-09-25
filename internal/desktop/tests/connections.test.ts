// Where connections live on the desktop: main writing one into the folder the
// engines read, and the panel's line for each.
//
// The text main writes arrives from the page, and the page is treated as a web
// page, so most of what is here is what main refuses to write whatever it was
// sent.

import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { parseConnection } from "@uno/grid/library";

import { writeConnection } from "../src/main/files.ts";
import { connectionLine } from "../src/renderer/sources.ts";

const ACME = fileURLToPath(new URL("../../grid/tests/testdata/acme-exports.unof", import.meta.url));

/** The folder a first save makes: it is not there before anything is connected. */
async function folder(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "uno-main-connections-")), "connections");
}

test("a connection is written as <id>.unof, in a folder made for it", async () => {
  const dir = await folder();
  const text = await readFile(ACME, "utf8");

  await writeConnection(dir, "acme-exports", text);
  expect(await readdir(dir)).toEqual(["acme-exports.unof"]);
  expect(await readFile(join(dir, "acme-exports.unof"), "utf8")).toBe(text);
});

test("text holding a key is refused, and nothing is written", async () => {
  const dir = await folder();
  const o = JSON.parse(await readFile(ACME, "utf8")) as Record<string, unknown>;
  o["aws_secret_access_key"] = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  await expect(writeConnection(dir, "acme-exports", JSON.stringify(o))).rejects.toThrow(
    /aws_secret_access_key looks like a secret/,
  );
  await expect(readdir(dir)).rejects.toThrow(/ENOENT/);
});

// The id names the file, so text claiming another id would put one
// connection's file under another's name.
test("text whose id is not the file it is written to is refused", async () => {
  const dir = await folder();
  await expect(writeConnection(dir, "finance", await readFile(ACME, "utf8"))).rejects.toThrow(
    'finance.unof holds connection "acme-exports", not finance',
  );
});

test("an id that names a path is refused before it becomes one", async () => {
  const dir = await folder();
  await expect(writeConnection(dir, "../acme", "{}")).rejects.toThrow(
    'connection id "../acme" may not start with a dot',
  );
});

test("text that is not a connection is refused", async () => {
  const dir = await folder();
  await expect(writeConnection(dir, "acme", '{"format":1,"kind":"column"}')).rejects.toThrow(
    "belongs in formulas/",
  );
});

test("a connection's line is its name, where browsing starts, and its region", async () => {
  const c = parseConnection("acme-exports.unof", await readFile(ACME, "utf8"));
  expect(connectionLine(c)).toEqual({
    id: "acme-exports",
    name: "ACME exports",
    path: "s3://acme-exports/shop/",
    kind: "s3",
    where: "eu-west-1",
  });

  // The whole bucket starts at its root, and a region nobody has asked for
  // yet is left unsaid rather than guessed.
  const root = { ...c, name: "", prefix: "", region: undefined };
  expect(connectionLine(root)).toEqual({
    id: "acme-exports",
    name: "acme-exports",
    path: "s3://acme-exports",
    kind: "s3",
  });
});
