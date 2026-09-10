// The disk's Lister: what `readdir` and `stat` say about a folder, as a listing.
//
// It is its own module rather than a second half of store/node.ts because the
// two do different work with the same syscalls. A handler answers one question
// about one file -- give me these bytes -- and a lister answers a question about
// a place: what is in here, in what order, and how much of it fits in a page.
// The one thing they share is that both are only ever allowed to reach a disk
// from inside the seam, which is why tests/store/opens.test.ts names this file
// beside store/node.ts and nowhere else.
//
// It is written as functions of what they were handed. A listing is a readdir
// put through four steps in a row -- say what each entry is, order them, drop
// what the cursor has already shown, take a page -- and every step is a function
// that reads its input and returns a new value, so any of them can be read, or
// changed, without knowing what the others do. Nothing here holds state between
// calls: two `list`s of the same folder are two readdirs and cannot disagree
// about anything except what the folder actually did in between.

import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { compareStrings } from "../go/index.ts";
import { isRemote } from "./index.ts";
import type { Entry, Lister, Listing } from "./list.ts";

/**
 * How many entries one page of a disk listing holds.
 *
 * A thousand, which is what one ListObjectsV2 answers with, so the panel scrolls
 * a folder and a prefix at the same rate and neither feels like the other's
 * special case.
 */
export const PAGE = 1_000;

/**
 * diskLister browses this machine's disks: one `readdir` for what is there, and
 * a `stat` for each entry of the page a caller actually asked for.
 *
 * `page` is a parameter because the page size is the lister's own -- `list` is
 * handed a path and a cursor and nothing else -- and a test that has to see a
 * second page should not have to write a thousand files to get one.
 */
export function diskLister(page: number = PAGE): Lister {
  return {
    label: "local files",
    // The same rule localFiles opens by, and for the same reason: a path with a
    // scheme in front of it belongs to whoever claims that scheme.
    handles: (path) => !isRemote(path),
    list: (dir, cursor) => listDir(dir, page, cursor),
    stat: statEntry,
  };
}

/** Row is one directory entry, once it is known what it is. */
interface Row {
  readonly name: string;
  readonly folder: boolean;
  /** The stat that followed a symlink, kept so the page need not ask twice. */
  readonly stats: Stats | undefined;
}

/**
 * listDir reads one page of a folder: classify, order, drop, take.
 *
 * Every page costs the whole readdir, and the order is why rather than the
 * paging: folders come first, so the last name in a directory can belong on the
 * first page, and nothing can be handed back until all of them have been seen. A
 * filesystem has no continuation token to hold that place with either. What
 * paging does save is the stats, which is where the time actually goes -- a
 * folder of 200,000 files costs one readdir and the fifty sizes on screen, not
 * 200,000 of them.
 *
 * A folder that is not there throws rather than answering empty, which is the
 * opposite of what `nodeStore.list` does with the formula library. A person who
 * has never written a formula has no folder and does not need to hear about it;
 * a person who browsed somewhere that has gone does, because an empty listing
 * would say the folder is there and has nothing in it.
 */
async function listDir(dir: string, page: number, cursor: string | undefined): Promise<Listing> {
  const found = await readdir(dir, { withFileTypes: true });
  const rows = (await rowsOf(dir, found)).toSorted(byPageKey).filter(from(cursor));

  const entries = await Promise.all(rows.slice(0, page).map(entryOf(dir)));
  // The first row the page left behind, which is where the next one starts. A
  // cursor the folder has since outrun leaves nothing to take and nothing to
  // point at, so it is the last page rather than the first.
  const after = rows[page];
  return after === undefined ? { entries } : { entries, next: pageKey(after) };
}

/**
 * rowsOf says what each thing in a directory is, following the links among them
 * first.
 *
 * A symlink is shown as what it points to, so following it belongs to working
 * out what a folder holds and not to reading a page of it: only a stat says
 * whether a link is a folder, and folders come first. The links go together
 * rather than one after another, so a folder of two hundred of them is one round
 * of waiting and not two hundred.
 */
async function rowsOf(dir: string, found: readonly Dirent[]): Promise<Row[]> {
  const links = found.filter((e) => e.isSymbolicLink());
  const followed = await Promise.all(links.map((e) => statOrNothing(join(dir, e.name))));
  const pointsAt = new Map(links.map((e, i) => [e.name, followed[i]]));

  return found.flatMap((e) => rowOf(e, pointsAt.get(e.name)));
}

/**
 * rowOf is what one directory entry turns into: one row, or none at all.
 *
 * None is a list of none rather than an absence, so classifying a folder is one
 * flatMap and not a map with a hole to filter out of it afterwards.
 *
 * Sockets, fifos and devices turn into none. Nothing in ingest reads one, and a
 * fifo is worse than useless in a browser: opening it would hang on a writer
 * that may never come, so the safest thing to do with one is not offer it.
 *
 * A link that cannot be followed -- dangling, a loop, a directory this person
 * may not stat -- becomes a file with no size. It is in the folder and `ls`
 * shows it, and a panel that draws a dash for a size it was not given already
 * has somewhere to put it.
 */
function rowOf(e: Dirent, linked: Stats | undefined): Row[] {
  if (e.isSymbolicLink()) {
    if (linked === undefined) return [{ name: e.name, folder: false, stats: undefined }];
    if (!linked.isDirectory() && !linked.isFile()) return [];
    return [{ name: e.name, folder: linked.isDirectory(), stats: linked }];
  }
  if (e.isDirectory()) return [{ name: e.name, folder: true, stats: undefined }];
  if (e.isFile()) return [{ name: e.name, folder: false, stats: undefined }];
  return [];
}

/**
 * pageKey is the order a disk listing comes back in, written as one string:
 * folders first, then by name.
 *
 * It is also the cursor, which is why it is a string and not a pair. A cursor
 * that were an index would slide by one when somebody saved a file into the
 * folder mid-scroll and a page would skip an entry; a key means "the entries
 * from here on" and stays true whatever happened to the folder meanwhile. `d`
 * sorts before `f`, so comparing two keys is comparing folder-ness and then the
 * name, and the order, the cursor and the comparison below are all this one
 * function rather than three that have to agree.
 */
function pageKey(row: Row): string {
  return `${row.folder ? "d" : "f"}:${row.name}`;
}

/** byPageKey orders a folder the way a listing promises: folders, then names. */
function byPageKey(a: Row, b: Row): number {
  return compareStrings(pageKey(a), pageKey(b));
}

/**
 * from is the test for "this page and the ones after it", as a function of the
 * cursor.
 *
 * No cursor keeps everything, so the first page and the rest are the same four
 * steps with nothing branching between them.
 */
function from(cursor: string | undefined): (row: Row) => boolean {
  if (cursor === undefined) return () => true;
  return (row) => compareStrings(pageKey(row), cursor) >= 0;
}

/**
 * entryOf fills in the size and the time for one entry of a page, in the folder
 * it was found in.
 *
 * `version` stays absent: a disk has nothing like an ETag, and task 3.3's
 * change test is written to compare sizes where there are no versions. Inventing
 * one out of the mtime would make it compare something it was told it could not
 * have.
 *
 * A directory gets no `bytes`. The size of a directory is the size of the list
 * of names in it, which is a number about the filesystem and not about anything
 * a person browsing is looking for.
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
 * statEntry is size and time now, for one path, without reading it.
 *
 * It follows a symlink, so it answers for what the link points to, the way a
 * listing shows it. A path that is not there throws as node wrote it: the
 * message already names the path, and the `code` on it is what callers here test
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

/**
 * statOrNothing is a stat whose failure is an answer.
 *
 * One entry that cannot be statted -- deleted between the readdir and here, a
 * link with no target, a mount that is not answering -- costs its own size and
 * not the folder it is in.
 */
async function statOrNothing(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}
