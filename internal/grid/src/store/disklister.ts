// The disk's Lister: a folder's readdir and stats as a listing.
//
// A listing is a readdir put through four steps: classify each entry, sort,
// drop what the cursor has already shown, take a page. Each call starts from
// a fresh readdir.
//
// Only this file and store/node.ts import node:fs. The guard test in
// tests/store/opens.test.ts checks that.

import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { compareStrings } from "../go/index.ts";
import { isRemote } from "./index.ts";
import type { Entry, Lister, Listing } from "./list.ts";
import { PAGE, byPageKey, pageKey } from "./list.ts";

// Re-exported for tests that page a folder by it.
export { PAGE };

/**
 * diskLister browses this machine's disks: one readdir per page, and a stat
 * for each entry on the page.
 *
 * `page` is the page size. Tests set it small.
 */
export function diskLister(page: number = PAGE): Lister {
  return {
    label: "local files",
    // Every scheme-free path, the same rule localFiles opens by.
    handles: (path) => !isRemote(path),
    list: (dir, cursor) => listDir(dir, page, cursor),
    stat: statEntry,
  };
}

/** Row is one directory entry, classified. */
interface Row {
  readonly name: string;
  readonly folder: boolean;
  /** The stat that followed a symlink, kept so the page reuses it. */
  readonly stats: Stats | undefined;
}

/**
 * listDir reads one page of a folder: classify, sort, drop, take.
 *
 * Every page costs the whole readdir, since folders sort first and the order
 * is only known once every entry is seen. Only the entries on the page are
 * statted.
 *
 * A missing folder throws.
 */
async function listDir(dir: string, page: number, cursor: string | undefined): Promise<Listing> {
  const found = namesOf(await readdir(dir, { withFileTypes: true, encoding: "buffer" }));
  const rows = (await rowsOf(dir, found)).toSorted(byPageKey).filter(from(cursor));

  const entries = await Promise.all(rows.slice(0, page).map(entryOf(dir)));
  // The first row after the page is where the next page starts. When the
  // rows end within the page, this is the last page.
  const after = rows[page];
  return after === undefined ? { entries } : { entries, next: pageKey(after) };
}

/** Found is one directory entry with its name decoded to a string. */
interface Found {
  readonly name: string;
  readonly entry: Dirent<Buffer>;
}

/** A decoder that throws on bytes outside UTF-8. */
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * namesOf decodes each entry's name as UTF-8 and keeps the names that
 * decode. Node would replace the bad bytes, giving a name that exists only
 * in the listing.
 */
function namesOf(found: readonly Dirent<Buffer>[]): Found[] {
  return found.flatMap((entry) => {
    try {
      return [{ name: utf8.decode(entry.name), entry }];
    } catch {
      return [];
    }
  });
}

/**
 * rowsOf classifies each entry. Symlinks are statted first, all at once, so a
 * link is shown as what it points to.
 */
async function rowsOf(dir: string, found: readonly Found[]): Promise<Row[]> {
  const links = found.filter((f) => f.entry.isSymbolicLink());
  const followed = await Promise.all(links.map((f) => statOrNothing(join(dir, f.name))));
  const pointsAt = new Map(links.map((f, i) => [f.name, followed[i]]));

  return found.flatMap((f) => rowOf(f, pointsAt.get(f.name)));
}

/**
 * rowOf turns one directory entry into a row, or none.
 *
 * Files and directories become rows. Sockets, fifos and devices are dropped.
 * A symlink becomes what it points to. A dangling one becomes a file with
 * its size and time left out.
 */
function rowOf({ name, entry }: Found, linked: Stats | undefined): Row[] {
  if (entry.isSymbolicLink()) {
    if (linked === undefined) return [{ name, folder: false, stats: undefined }];
    if (!linked.isDirectory() && !linked.isFile()) return [];
    return [{ name, folder: linked.isDirectory(), stats: linked }];
  }
  if (entry.isDirectory()) return [{ name, folder: true, stats: undefined }];
  if (entry.isFile()) return [{ name, folder: false, stats: undefined }];
  return [];
}

/**
 * from is the filter for the page at `cursor` and the pages after it. An
 * undefined cursor keeps everything.
 */
function from(cursor: string | undefined): (row: Row) => boolean {
  if (cursor === undefined) return () => true;
  return (row) => compareStrings(pageKey(row), cursor) >= 0;
}

/**
 * entryOf stats one row and builds its Entry: `modified` from the stat, and
 * `bytes` for a file. A folder gets `modified` alone. `version` is absent on
 * disk.
 */
function entryOf(dir: string): (row: Row) => Promise<Entry> {
  return async (row) => {
    const path = join(dir, row.name);
    const st = row.stats ?? (await statOrNothing(path));
    return {
      name: row.name,
      path,
      folder: row.folder,
      ...(st === undefined ? {} : { modified: st.mtime }),
      ...(st === undefined || row.folder ? {} : { bytes: st.size }),
    };
  };
}

/**
 * statEntry is the size and time of one path, from one stat. It follows a
 * symlink. A missing path throws node's own error, whose `code` callers test
 * for.
 */
async function statEntry(path: string): Promise<Entry> {
  const st = await stat(path);
  return {
    name: basename(path),
    path,
    folder: st.isDirectory(),
    modified: st.mtime,
    ...(st.isDirectory() ? {} : { bytes: st.size }),
  };
}

/** statOrNothing is a stat that returns undefined on failure. */
async function statOrNothing(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}
