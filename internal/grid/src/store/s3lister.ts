// A bucket's Lister: one ListObjectsV2 page as a listing.
//
// Every request goes through `s3Requests` in store/s3.ts, which signs,
// retries and follows a bucket to its region.
//
// Listing uses `delimiter=/`. Keys flat under the prefix come back
// as Contents and become files. Deeper keys are folded into CommonPrefixes
// and become folders.

import type { Entry, Lister, Listing } from "./list.ts";
import { PAGE, byPageKey } from "./list.ts";
import type { S3Options, S3Requests } from "./s3.ts";
import {
  answered,
  objectAt,
  refused,
  s3Location,
  s3Requests,
  s3Url,
  sizeOf,
  versionOf,
} from "./s3.ts";
import { readListing, when } from "./s3xml.ts";
import type { KeyEntry } from "./s3xml.ts";

/**
 * s3Lister browses buckets: one ListObjectsV2 per page, and one HEAD per
 * stat.
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

/** A place in a bucket: the bucket, and the prefix inside it. */
export interface S3Prefix {
  bucket: string;
  /** Empty for the whole bucket. Otherwise as it was given, slash and all. */
  prefix: string;
}

/**
 * s3Prefix reads the address of a place in a bucket: `s3://bucket`, bare or
 * with a trailing slash, or any address s3Location reads, with its key as
 * the prefix. Undefined for anything else.
 */
export function s3Prefix(path: string): S3Prefix | undefined {
  const root = /^s3:\/\/([^/]+)\/?$/i.exec(path.trim());
  if (root !== null) return { bucket: root[1]!, prefix: "" };

  const loc = s3Location(path);
  return loc === undefined ? undefined : { bucket: loc.bucket, prefix: loc.key };
}

/**
 * listPrefix reads one page of a prefix: request, parse, classify, sort.
 *
 * The cursor is S3's continuation token, passed through as it came. The
 * prefix is sent as it was given, dot segments included, since it goes in
 * the query, which is sent verbatim.
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
  if (!res.ok) {
    const who = await send.who({ bucket: where.bucket, key: where.prefix });
    throw new Error(`${path}: ${cannotList(res.status, who)}`);
  }
  const page = readListing(await res.text());

  // A truncated page needs a continuation token to page further.
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
 * folderAt is one common prefix as a folder entry. Its path keeps the
 * trailing slash, which `list` is handed next. Its name is the last segment.
 * It has no `bytes`.
 */
function folderAt(bucket: string, prefix: string): Entry {
  return {
    name: lastSegment(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix),
    path: s3Url({ bucket, key: prefix }),
    folder: true,
  };
}

/**
 * fileAt is one key as a file entry, or none.
 *
 * It drops the folder marker: a key equal to the prefix, or ending in a
 * slash. `version` is the ETag from the listing.
 */
function fileAt(bucket: string, prefix: string, key: KeyEntry): Entry[] {
  if (key.key === prefix || key.key.endsWith("/")) return [];
  // Only the fields keyIn could read are present, so they carry over as is.
  const { key: k, ...facts } = key;
  return [{ name: lastSegment(k), path: s3Url({ bucket, key: k }), folder: false, ...facts }];
}

/**
 * statObject is one HEAD of an object: its size, version and last-modified
 * time, from headers alone.
 */
async function statObject(send: S3Requests, path: string): Promise<Entry> {
  const loc = objectAt(path, path);
  const url = s3Url(loc);
  const head = await send.object(loc, "HEAD", {});
  if (!head.ok) throw await refused(send, loc, head);
  const bytes = sizeOf(head, url);

  // Read the same way the handler reads it at open: the VersionId where the
  // bucket keeps versions, the ETag otherwise, so the two compare equal.
  const version = versionOf(head.headers);
  const modified = when(head.headers.get("last-modified"));
  return {
    name: lastSegment(loc.key),
    path: url,
    folder: false,
    bytes,
    ...(modified === undefined ? {} : { modified }),
    ...(version === undefined || version === "" ? {} : { version }),
  };
}

/** Everything after the last slash of a key. */
function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/**
 * cannotList is what a status code means for a listing. A 404 is a missing
 * bucket, since an empty prefix is an empty listing. A 403 names
 * s3:ListBucket.
 */
function cannotList(status: number, who: string): string {
  return answered(status, {
    403: `access denied · ${who} cannot list that bucket (s3:ListBucket)`,
    404: "no such bucket",
  });
}
