// The disk lister, against a real folder.
//
// The folder is a temp directory with the testdata fixtures copied into it, so
// what is under test is a readdir and a stat and not a stand-in: the sizes are
// the sizes of those files, and the order is the order the filesystem was asked
// for and then put into.
//
// Nothing here symlinks a fixture into place. The data is copied, and the links
// that are under test point at the copies.

import { copyFile, lstat, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import type { Entry } from "../../src/store/index.ts";
import { readAll } from "../../src/store/index.ts";
import { diskLister, localFiles } from "../../src/store/node.ts";

const TESTDATA = fileURLToPath(new URL("../testdata/", import.meta.url));

/** The fixtures copied into the folder under test, and the folders beside them. */
const FILES = ["sales-q3.csv", "google-ads-sales.csv", "unit-margin.unof"];
const FOLDERS = ["reports", "archive"];

/**
 * folder builds the directory every check below browses: three fixtures, two
 * empty folders, a link to one of each, and a link to nothing.
 */
async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uno-disk-"));
  for (const name of FOLDERS) await mkdir(join(dir, name));
  for (const name of FILES) await copyFile(join(TESTDATA, name), join(dir, name));
  await symlink(join(dir, "sales-q3.csv"), join(dir, "latest.csv"));
  await symlink(join(dir, "reports"), join(dir, "linked-folder"));
  await symlink(join(dir, "never-written.csv"), join(dir, "gone.csv"));
  return dir;
}

/** Folders first and then by name, which is the order every check expects. */
const ORDER = [
  "archive",
  "linked-folder",
  "reports",
  "gone.csv",
  "google-ads-sales.csv",
  "latest.csv",
  "sales-q3.csv",
  "unit-margin.unof",
];

function named(entries: Entry[]): string[] {
  return entries.map((e) => e.name);
}

test("a folder comes back folders first and then by name", async () => {
  const dir = await folder();

  const listing = await diskLister().list(dir);

  expect(named(listing.entries)).toEqual(ORDER);
  expect(listing.entries.filter((e) => e.folder).map((e) => e.name)).toEqual([
    "archive",
    "linked-folder",
    "reports",
  ]);
  expect(listing.next, "one page holds a folder this small").toBeUndefined();
});

// The page size is the lister's own, so a test that wants a second page sets it
// rather than writing a thousand files to earn one.
test("a folder is paged by a cursor, two at a time", async () => {
  const dir = await folder();
  const disk = diskLister(2);

  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await disk.list(dir, cursor);
    pages.push(named(page.entries));
    cursor = page.next;
  } while (cursor !== undefined);

  expect(pages).toEqual([
    ["archive", "linked-folder"],
    ["reports", "gone.csv"],
    ["google-ads-sales.csv", "latest.csv"],
    ["sales-q3.csv", "unit-margin.unof"],
  ]);
  expect(pages.flat(), "the pages are the folder, in the same order").toEqual(ORDER);
});

// The cursor is where the next page starts, and it is the lister's own token:
// the first entry of a page is the one the previous page's `next` named.
test("the cursor names where the next page starts", async () => {
  const dir = await folder();
  const disk = diskLister(2);

  const first = await disk.list(dir);
  expect(first.next).toBe("d:reports");

  const second = await disk.list(dir, first.next);
  expect(second.entries[0]!.name).toBe("reports");
});

// A cursor from a folder that has since shrunk is the end of the listing, not
// the start of it: a page of nothing is right, and the whole folder again is
// not.
test("a cursor past the end is an empty last page", async () => {
  const dir = await folder();

  const listing = await diskLister(2).list(dir, "f:zzzz");

  expect(listing.entries).toEqual([]);
  expect(listing.next).toBeUndefined();
});

test("a listing carries the size a file weighs, and folders carry none", async () => {
  const dir = await folder();

  const { entries } = await diskLister().list(dir);
  const by = new Map(entries.map((e) => [e.name, e]));

  expect(by.get("sales-q3.csv")!.bytes).toBe((await stat(join(TESTDATA, "sales-q3.csv"))).size);
  expect(by.get("google-ads-sales.csv")!.bytes).toBe(
    (await stat(join(TESTDATA, "google-ads-sales.csv"))).size,
  );
  expect(by.get("reports")!.bytes, "a directory's size is about the filesystem").toBeUndefined();
  expect(by.get("sales-q3.csv")!.modified).toBeInstanceOf(Date);
});

// A disk has nothing like an ETag, and task 3.3's change test compares sizes
// where there are no versions. An mtime dressed up as a version would break
// that quietly.
test("nothing on a disk carries a version", async () => {
  const dir = await folder();

  const { entries } = await diskLister().list(dir);

  expect(entries.filter((e) => e.version !== undefined)).toEqual([]);
});

test("a symlink is listed as what it points to", async () => {
  const dir = await folder();

  const { entries } = await diskLister().list(dir);
  const by = new Map(entries.map((e) => [e.name, e]));

  const link = by.get("latest.csv")!;
  expect(link.folder).toBe(false);
  expect(link.bytes, "the size of the file it points at").toBe(
    (await stat(join(TESTDATA, "sales-q3.csv"))).size,
  );

  const toFolder = by.get("linked-folder")!;
  expect(toFolder.folder, "a link to a folder is a folder, and sorts with them").toBe(true);
  expect(toFolder.bytes).toBeUndefined();
});

// It is in the folder and `ls` shows it, so hiding it would be the quieter lie.
// The panel draws a dash where it was given no size.
test("a link that points nowhere is listed with no size", async () => {
  const dir = await folder();

  const { entries } = await diskLister().list(dir);
  const gone = entries.find((e) => e.name === "gone.csv")!;

  expect(gone.folder).toBe(false);
  expect(gone.bytes).toBeUndefined();
  expect(gone.modified).toBeUndefined();
});

// Nothing in ingest reads a socket, and opening a fifo would wait for a writer
// that may never come. Not offering one is the only safe thing to do with it.
test("a socket is not listed", async () => {
  const dir = await folder();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(join(dir, "engine.sock"), resolve));
  try {
    expect((await lstat(join(dir, "engine.sock"))).isSocket(), "the socket is there").toBe(true);
    const { entries } = await diskLister().list(dir);
    expect(named(entries)).toEqual(ORDER);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// An entry's path is what a FileRef carries, so a caller that browsed to a file
// already holds everything openWith needs, with no joining to do.
test("an entry's path is one the handler opens", async () => {
  const dir = await folder();

  const { entries } = await diskLister().list(dir);
  const found = entries.find((e) => e.name === "unit-margin.unof")!;

  const read = await readAll([localFiles()], { name: found.name, path: found.path });
  expect(read).toEqual(await readFixture("unit-margin.unof"));
});

async function readFixture(name: string): Promise<Uint8Array> {
  return readAll([localFiles()], { name, path: join(TESTDATA, name) });
}

// The opposite of what nodeStore.list does with the formula library, and on
// purpose: an empty listing would say the folder is there and has nothing in
// it.
test("a folder that is not there is a failure and not an empty one", async () => {
  const dir = await folder();

  await expect(diskLister().list(join(dir, "never-created"))).rejects.toThrow("ENOENT");
});

test("browsing a file rather than a folder fails naming it", async () => {
  const dir = await folder();

  await expect(diskLister().list(join(dir, "sales-q3.csv"))).rejects.toThrow("sales-q3.csv");
});

test("stat is the size and the time now, without reading the file", async () => {
  const dir = await folder();
  const disk = diskLister();

  const file = await disk.stat(join(dir, "sales-q3.csv"));
  expect(file.name).toBe("sales-q3.csv");
  expect(file.folder).toBe(false);
  expect(file.bytes).toBe((await stat(join(TESTDATA, "sales-q3.csv"))).size);
  expect(file.modified).toBeInstanceOf(Date);
  expect(file.version).toBeUndefined();

  const dirEntry = await disk.stat(join(dir, "reports"));
  expect(dirEntry.folder).toBe(true);
  expect(dirEntry.bytes).toBeUndefined();
});

test("stat follows a link, the way the listing shows it", async () => {
  const dir = await folder();

  const link = await diskLister().stat(join(dir, "latest.csv"));

  expect(link.name, "the link's own name, not the target's").toBe("latest.csv");
  expect(link.bytes).toBe((await stat(join(TESTDATA, "sales-q3.csv"))).size);
});

// A source that has been moved or deleted is the case behind "newer in the
// bucket", and it has to fail rather than answer with a zero.
test("a stat of something that is not there names it", async () => {
  const dir = await folder();

  await expect(diskLister().stat(join(dir, "never-written.csv"))).rejects.toThrow(
    "never-written.csv",
  );
});

test("the disk lister claims paths and leaves schemes alone", () => {
  const disk = diskLister();

  expect(disk.handles("/home/jo/exports")).toBe(true);
  expect(disk.handles("C:\\Users\\jo")).toBe(true);
  expect(disk.handles("s3://acme-exports/shop/")).toBe(false);
  expect(disk.handles("https://example.com/a/")).toBe(false);
});

// A folder with nothing in it is a folder with nothing in it, which is a
// different answer from a folder that is not there.
test("an empty folder is an empty listing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-disk-empty-"));

  const listing = await diskLister().list(dir);

  expect(listing.entries).toEqual([]);
  expect(listing.next).toBeUndefined();
});

// Deciding what a person should not see is the panel's filter box and not the
// store's: a dotfile is in the folder, and something that browses a folder for
// a .unof has to be able to find one in ~/.config.
test("a dotfile is listed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-disk-dot-"));
  await writeFile(join(dir, ".hidden.csv"), "a,b\n1,2\n");

  const { entries } = await diskLister().list(dir);

  expect(named(entries)).toEqual([".hidden.csv"]);
});
