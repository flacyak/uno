// Main writing a workspace file.
//
// A failed write leaves the existing file as it was, and removes its
// scratch file. unoPath adds the .uno extension when a Save As path lacks
// it.

import { mkdtemp, mkdir, readFile, readdir, stat, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

import { unoPath, writeAtomic } from "../src/main/files.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The mode of an ordinary user file, as stat reports it with the type bits. */
const USER_FILE = 0o100644;

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), "uno-main-files-"));
}

test("a write lands as an ordinary user file", async () => {
  const dir = await folder();
  await writeAtomic(join(dir, "a.uno"), bytes("one"));
  expect(await readFile(join(dir, "a.uno"), "utf8")).toBe("one");
  expect((await stat(join(dir, "a.uno"))).mode).toBe(USER_FILE);
  expect(await readdir(dir)).toEqual(["a.uno"]);
});

test("a folder that is not there is said, and nothing is left where it would be", async () => {
  const dir = await folder();
  await expect(writeAtomic(join(dir, "nope", "a.uno"), bytes("one"))).rejects.toThrow(/ENOENT/);
  expect(await readdir(dir)).toEqual([]);
});

test("a folder that cannot be written is said, and no scratch is left in the parent", async () => {
  const dir = await folder();
  const ro = join(dir, "ro");
  await mkdir(ro);
  await chmod(ro, 0o500);
  try {
    await expect(writeAtomic(join(ro, "a.uno"), bytes("one"))).rejects.toThrow(/EACCES/);
  } finally {
    await chmod(ro, 0o700);
  }
  expect(await readdir(dir)).toEqual(["ro"]);
  expect(await readdir(ro)).toEqual([]);
});

// The rename fails after the bytes are written. The scratch is still removed.
test("a path that is a folder is refused, and the scratch is removed", async () => {
  const dir = await folder();
  await mkdir(join(dir, "d.uno"));
  await expect(writeAtomic(join(dir, "d.uno"), bytes("one"))).rejects.toThrow(/EISDIR/);
  expect(await readdir(dir)).toEqual(["d.uno"]);
});

test("a file that was there is still there after a failed write", async () => {
  const dir = await folder();
  await writeFile(join(dir, "a.uno"), "was");
  await chmod(dir, 0o500);
  try {
    await expect(writeAtomic(join(dir, "a.uno"), bytes("now"))).rejects.toThrow(/EACCES/);
  } finally {
    await chmod(dir, 0o700);
  }
  expect(await readFile(join(dir, "a.uno"), "utf8")).toBe("was");
});

// Two writes of one path each use their own scratch file. The last to land
// is the file, whole.
test("two writes of one path at once leave one of them, whole", async () => {
  const dir = await folder();
  const one = "one".repeat(10_000);
  const two = "two".repeat(10_000);
  await Promise.all([
    writeAtomic(join(dir, "a.uno"), bytes(one)),
    writeAtomic(join(dir, "a.uno"), bytes(two)),
  ]);
  const got = await readFile(join(dir, "a.uno"), "utf8");
  expect([one, two]).toContain(got);
  expect(await readdir(dir)).toEqual(["a.uno"]);
});

// The Save As dialog on GTK answers with the bare name as typed. The engine
// knows a workspace by its .uno extension.
test("a picked path is given the workspace extension when it was typed without", () => {
  expect(unoPath("/home/me/sales")).toBe("/home/me/sales.uno");
  expect(unoPath("/home/me/sales.csv")).toBe("/home/me/sales.csv.uno");
  expect(unoPath("/home/me/sales.uno")).toBe("/home/me/sales.uno");
  expect(unoPath("/home/me/SALES.UNO")).toBe("/home/me/SALES.UNO");
});
