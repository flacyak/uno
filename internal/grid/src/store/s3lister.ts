// A bucket's Lister: what ListObjectsV2 says about a prefix, as a listing.
//
// It is its own module rather than a second half of store/s3.ts for the reason
// the disk's two are two files. A handler answers one question about one object
// -- give me these bytes -- and a lister answers a question about a place: what
// is in here, in what order, and how much of it fits in a page. What the disk's
// two share is the syscall; what these two share is the request, and they share
// it rather than each keep one: signing, the backoff and following a bucket to
// its region are `s3Requests` in store/s3.ts, and nothing here sends anything of
// its own, which is why the guard test's allow-list did not move for this file.
//
// A prefix is not a folder. A bucket holds keys, and one of them can be called
// `shop/2025/orders.csv` with nothing called `shop/` existing anywhere, so
// `delimiter=/` is what makes a flat list browsable: keys with no slash left in
// them after the prefix come back as Contents, and everything deeper comes back
// folded into CommonPrefixes. The folders in a listing are those prefixes, and
// they are exactly as real as the keys underneath them.
//
// It is written as functions of what they were handed, the way
// store/disklister.ts is. One page is a query, the reply read for the elements
// it uses, the two halves of it turned into entries, and an order put on them.
// Nothing holds state between calls: two lists of the same prefix are two
// requests and cannot disagree about anything but what the bucket did between
// them.

import { compareStrings } from "../go/index.ts";
import type { Entry, Lister, Listing } from "./list.ts";
import type { S3Options, S3Requests } from "./s3.ts";
import { refusal, s3Location, s3Requests, s3Url, unaddressable } from "./s3.ts";
import { readListing } from "./s3xml.ts";
import type { KeyEntry } from "./s3xml.ts";

/**
 * How many entries one page of a listing asks for.
 *
 * A thousand, which is what ListObjectsV2 answers with when it is not told
 * otherwise and what the disk lister pages at, so the panel scrolls a prefix and
 * a folder at the same rate and neither feels like the other's special case. It
 * is sent rather than left to default, because a page is what the panel draws
 * and a bucket quietly changing its own default would change how far one scroll
 * goes.
 */
export const PAGE = 1_000;

/**
 * s3Lister browses buckets: one ListObjectsV2 per page, and a HEAD for the one
 * object somebody asked about.
 *
 * There is no page-size parameter, unlike the disk's. A test that wants a second
 * page puts another thousand keys in the stand-in's Map, which costs a Map entry
 * each, where the disk lister would have had to write a thousand files.
 */
export function s3Lister(opts: S3Options): Lister {
  const send = s3Requests(opts);
  return {
    label: "S3",
    handles: (path) => s3Prefix(path) !== undefined,
    list: (path, cursor) => listPrefix(send, path, cursor),
    stat: (path) => statObject(send, path),
  };
}

/** Where a listing was asked for: a bucket, and how far into it. */
export interface S3Prefix {
  bucket: string;
  /** Empty for the whole bucket. Otherwise as it was given, slash and all. */
  prefix: string;
}

/**
 * s3Prefix reads the address of a place in a bucket.
 *
 * It is the handler's own reading of an address plus the one address a handler
 * has no use for: a bucket with nothing after it, which is where a person
 * browsing starts and which `s3Location` refuses because it is not an object. A
 * prefix is otherwise exactly what a key is, so the ways people write one down
 * -- the s3:// form uno writes and pastes, the https forms a browser shows --
 * are not read twice.
 *
 * A bucket root written the https way is not claimed, because that address only
 * ever comes from a browser looking at one object, and the form uno itself
 * writes down is s3://.
 */
export function s3Prefix(path: string): S3Prefix | undefined {
  const root = /^s3:\/\/([^/]+)\/?$/i.exec(path.trim());
  if (root !== null) return { bucket: root[1]!, prefix: "" };

  const loc = s3Location(path);
  return loc === undefined ? undefined : { bucket: loc.bucket, prefix: loc.key };
}

/**
 * listPrefix reads one page of a prefix: ask, read, classify, order.
 *
 * The cursor is the bucket's own continuation token, handed back exactly as it
 * came. The disk lister had to invent a cursor because a filesystem has none;
 * this is the opposite case, and the token is the only thing that can be sent,
 * because it stands for a place in the key space that nothing outside the bucket
 * can compute. It is what makes a prefix of two million keys pageable at all.
 *
 * The prefix is sent as it was handed over, dot segments and everything: it
 * travels in the query rather than the path, so no URL resolves it away, and a
 * bucket really can hold a key called `a/../b`. What such a key cannot do is be
 * opened, and the entry's own path is refused by name when somebody tries.
 */
async function listPrefix(
  send: S3Requests,
  path: string,
  cursor: string | undefined,
): Promise<Listing> {
  const where = s3Prefix(path);
  if (where === undefined) throw new Error(`${path}: not a place in S3`);

  const res = await send.bucket(where.bucket, {
    "list-type": "2",
    delimiter: "/",
    "max-keys": String(PAGE),
    ...(where.prefix === "" ? {} : { prefix: where.prefix }),
    ...(cursor === undefined ? {} : { "continuation-token": cursor }),
  });
  if (!res.ok) throw new Error(`${path}: ${cannotList(res.status)}`);
  const page = readListing(await res.text());

  // A bucket that says there is more and does not say where it starts would
  // lose the rest of the prefix without a word, which is the quietest lie a
  // listing can tell: a panel would stop scrolling and look finished.
  if (page.truncated && page.next === undefined) {
    throw new Error(
      `${path}: S3 says this prefix has more pages but not where the next one starts`,
    );
  }

  const entries = [
    ...page.prefixes.map((prefix) => folderAt(where.bucket, prefix)),
    ...page.keys.flatMap((key) => fileAt(where.bucket, where.prefix, key)),
  ].toSorted(byPageKey);
  return page.next === undefined ? { entries } : { entries, next: page.next };
}

/**
 * folderAt is one prefix a page folded keys into, as an entry.
 *
 * Its path keeps the trailing slash the bucket sent, because that path is what
 * `list` is handed next and a prefix without its slash is a different prefix.
 * Its name is the last segment, which is the part of it a person is looking at.
 *
 * It carries no `bytes`. A prefix has no size -- there is nothing there to have
 * one -- and adding up the keys under it would be a listing of the whole subtree
 * per row.
 */
function folderAt(bucket: string, prefix: string): Entry {
  return {
    name: lastSegment(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix),
    path: s3Url({ bucket, key: prefix }),
    folder: true,
  };
}

/**
 * fileAt is one key of a page as an entry, or nothing where the key is not one
 * worth listing.
 *
 * Nothing is a list of none rather than an absence, the way the disk lister
 * classifies a directory entry, so this is one flatMap and not a map with a hole
 * to filter out afterwards.
 *
 * What it drops is the folder marker: a console that makes a folder in a bucket
 * writes a zero-byte object whose key is the prefix itself, and listing that
 * prefix hands the marker back among the keys. It has no name left once the
 * prefix is taken off it, and the folder it stands for is in the listing already
 * as a prefix.
 *
 * `version` is the ETag, which ListObjectsV2 gives away for free, so a listing
 * answers "is the bucket's copy the one this workspace read" without a stat per
 * row. A disk has nothing like it and leaves it absent; this is the case that
 * field exists for.
 */
function fileAt(bucket: string, prefix: string, key: KeyEntry): Entry[] {
  if (key.key === prefix || key.key.endsWith("/")) return [];
  return [
    {
      name: lastSegment(key.key),
      path: s3Url({ bucket, key: key.key }),
      folder: false,
      ...(key.bytes === undefined ? {} : { bytes: key.bytes }),
      ...(key.modified === undefined ? {} : { modified: key.modified }),
      ...(key.version === undefined ? {} : { version: key.version }),
    },
  ];
}

/**
 * pageKey is the order a listing promises, written as one string: folders first,
 * then by name. `d` sorts before `f`, so one string compare is both halves of
 * it.
 *
 * Unlike the disk's it is only an order and not also the cursor, because the
 * bucket's token is the cursor. And it holds within a page rather than across a
 * prefix, which it cannot help: a bucket pages its keys and the prefixes they
 * fold into together, in one UTF-8 order, so a page after this one can hold a
 * folder whose name sorts before a file on this one. Promising more would mean
 * reading every page of a prefix before answering with the first, and for two
 * million keys that is a listing nobody waits for. The disk pays a readdir per
 * page to promise it everywhere; a bucket cannot be asked that way at any price.
 */
function pageKey(entry: Entry): string {
  return `${entry.folder ? "d" : "f"}:${entry.name}`;
}

/** byPageKey orders a page the way a listing promises: folders, then names. */
function byPageKey(a: Entry, b: Entry): number {
  return compareStrings(pageKey(a), pageKey(b));
}

/**
 * statObject is how big an object is and which version of it that is, now,
 * without reading a byte of it: the HEAD `open` already sends first.
 *
 * It is what "newer in the bucket than in this workspace" is decided from, and a
 * workspace with forty sources asks it forty times on open, so it stays one
 * request and does not become a listing of one entry -- which would cost a
 * ListObjectsV2 over the whole prefix to find one key in it.
 */
async function statObject(send: S3Requests, path: string): Promise<Entry> {
  const loc = s3Location(path);
  if (loc === undefined) throw new Error(`${path}: not an object in S3`);
  // The same refusal `open` makes, in the same words, because this is about to
  // do the same thing: turn a key into a URL, which resolves a dot segment away
  // before anything signs it.
  const cannot = unaddressable(loc);
  if (cannot !== undefined) throw cannot;

  const url = s3Url(loc);
  const head = await send.object(loc, "HEAD", {});
  if (!head.ok) throw new Error(`${url}: ${refusal(head.status)}`);
  const bytes = Number(head.headers.get("content-length") ?? "NaN");
  if (!Number.isFinite(bytes)) throw new Error(`${url}: S3 did not say how big it is`);

  const etag = head.headers.get("etag");
  const modified = when(head.headers.get("last-modified"));
  return {
    name: lastSegment(loc.key),
    path: url,
    folder: false,
    bytes,
    ...(modified === undefined ? {} : { modified }),
    ...(etag === null || etag === "" ? {} : { version: etag }),
  };
}

/** The date a header names, or nothing where it names none. */
function when(stamp: string | null): Date | undefined {
  if (stamp === null) return undefined;
  const at = new Date(stamp);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** The part of a key a person reads: everything after the last slash. */
function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/**
 * What S3's status codes mean when it was asked for a listing.
 *
 * They are not the handler's, which is why they are written out again here: a
 * 404 to a GET of an object is a missing object, and to a listing it is a
 * missing bucket, because a prefix with nothing under it is an empty listing and
 * not an error. A 403 is `s3:ListBucket` rather than `s3:GetObject`, which is
 * the permission people forget, so it says which one it wanted.
 */
function cannotList(status: number): string {
  switch (status) {
    case 403:
      return "access denied · the AWS credentials uno found cannot list that bucket (s3:ListBucket)";
    case 404:
      return "no such bucket";
    default:
      return `S3 answered ${status}`;
  }
}
