// Main writing a workspace: the one operation that can destroy something.
//
// Every failure a write can meet leaves the file that was there, and leaves
// no scratch of its own behind beside it. The path a Save As dialog answers
// with is a workspace's, which on a desktop that does not add the extension
// for the filter means adding it here.

import { mkdtemp, mkdir, readFile, readdir, stat, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

import { unoPath, writeAtomic } from "../src/main/files.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The mode an ordinary user file has, as stat reports it with the type bits. */
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

// The rename is where this fails, after the bytes are written: the scratch
// the bytes went to is removed all the same.
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

// Two saves of one path at once each write their own scratch and publish it
// whole: whichever lands last is the file, and no byte of the other is in it.
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

// The Save As dialog filters on .uno, and on GTK answers with the name as
// typed. A workspace saved without the extension would open as a spreadsheet
// the next time, since the engine knows a .uno by its name.
test("a picked path is given the workspace extension when it was typed without", () => {
  expect(unoPath("/home/me/sales")).toBe("/home/me/sales.uno");
  expect(unoPath("/home/me/sales.csv")).toBe("/home/me/sales.csv.uno");
  expect(unoPath("/home/me/sales.uno")).toBe("/home/me/sales.uno");
  expect(unoPath("/home/me/SALES.UNO")).toBe("/home/me/SALES.UNO");
});
