// The Lister interface: browsing a folder or a prefix one page at a time.
//
// The disk lister is store/disklister.ts and the bucket lister is
// store/s3lister.ts. The error for a path every lister declines is built in
// store/claim.ts.

import { compareStrings } from "../go/index.ts";
import { BROWSES, claim } from "./claim.ts";

/**
 * How many entries one page of a listing holds. Sent to S3 as max-keys, and
 * used by the disk lister as its page size.
 */
export const PAGE = 1_000;

/** Named is what a listing's order is decided from: folder or file, and name. */
export interface Named {
  readonly name: string;
  readonly folder: boolean;
}

/**
 * pageKey is the sort key of an entry: folders first, then by name. `d` sorts
 * before `f`, so one string compare gives both.
 *
 * The disk lister also uses it as the cursor, so it must stay a string. For a
 * bucket the order holds within one page only, since S3 pages keys and common
 * prefixes together in UTF-8 order.
 */
export function pageKey(named: Named): string {
  return `${named.folder ? "d" : "f"}:${named.name}`;
}

/** byPageKey orders entries folders first, then by name. */
export function byPageKey(a: Named, b: Named): number {
  return compareStrings(pageKey(a), pageKey(b));
}

/**
 * Entry is one thing a listing found. `path` is what a FileRef carries, so an
 * entry can be opened as it is.
 *
 * `bytes`, `modified` and `version` are set where the listing had them.
 */
export interface Entry {
  name: string;
  /** What a FileRef would carry: /home/…/a.csv, s3://bucket/key. */
  path: string;
  folder: boolean;
  bytes?: number;
  modified?: Date;
  /** ETag, or S3 VersionId when the bucket keeps versions. */
  version?: string;
}

/** Listing is one page of a folder or a prefix, folders first and then by
 * name. */
export interface Listing {
  entries: Entry[];
  /** Where the next page starts, when there is one. Absent at the end. */
  next?: string;
}

/**
 * Lister browses one kind of place: a disk, a bucket.
 *
 * `handles` looks at the path only. `stat` is one request and stays cheap: a
 * workspace stats every source on open.
 */
export interface Lister {
  /** The kind of place, as an error names it. */
  readonly label: string;
  /** Whether `path` is one this lister browses. */
  handles(path: string): boolean;
  /** One page from `cursor`, or the first page when there is none. */
  list(path: string, cursor?: string): Promise<Listing>;
  /** Size and version now, from metadata alone. */
  stat(path: string): Promise<Entry>;
}

/**
 * listWith lists a path through the first lister that claims it. Throws,
 * naming the kinds this build browses, when none does.
 */
export async function listWith(
  listers: readonly Lister[],
  path: string,
  cursor?: string,
): Promise<Listing> {
  return claim(listers, path, (l) => l.handles(path), BROWSES).list(path, cursor);
}

/**
 * statWith stats a path through the first lister that claims it, with the
 * same error as listWith when none does.
 */
export async function statWith(listers: readonly Lister[], path: string): Promise<Entry> {
  return claim(listers, path, (l) => l.handles(path), BROWSES).stat(path);
}
