// Browsing a bucket: readListing on XML strings, s3Prefix and the lister's
// claims, and the S3 lister against the stand-in.

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Entry } from "../../src/store/index.ts";
import { s3Files, s3Provider } from "../../src/store/s3.ts";
import { s3Lister, s3Prefix } from "../../src/store/s3lister.ts";
import { readListing } from "../../src/store/s3xml.ts";
import { bytes } from "../testdata/sales-q3.ts";
import { AWKWARD_KEYS, DOT_KEYS } from "./awkward.ts";
import { HOME_REGION } from "./regions.ts";
import { BUCKET, KEYS, MODIFIED, bucket, etagOf } from "./standin.ts";
import type { Bucket } from "./standin.ts";

// ------------------------------------------------------------ the reader

const PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>acme-exports</Name>
  <Prefix>shop/</Prefix>
  <Delimiter>/</Delimiter>
  <MaxKeys>1000</MaxKeys>
  <KeyCount>3</KeyCount>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>shop/a&amp;b.csv</Key>
    <LastModified>2026-09-20T12:00:00.000Z</LastModified>
    <ETag>&quot;9b2cf5&quot;</ETag>
    <Size>2040109871</Size>
    <StorageClass>INTELLIGENT_TIERING</StorageClass>
  </Contents>
  <CommonPrefixes><Prefix>shop/2025/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>shop/archive/</Prefix></CommonPrefixes>
</ListBucketResult>`;

test("a ListBucketResult is read for the elements it is made of", () => {
  const page = readListing(PAGE_XML);

  expect(page.keys).toEqual([
    {
      key: "shop/a&b.csv",
      bytes: 2040109871,
      modified: new Date("2026-09-20T12:00:00.000Z"),
      version: '"9b2cf5"',
    },
  ]);
  expect(page.prefixes).toEqual(["shop/2025/", "shop/archive/"]);
  expect(page.truncated).toBe(false);
  expect(page.next).toBeUndefined();
});

// The top-level Prefix element echoes the request, so it is left out of the
// folders.
test("the prefix the bucket echoes back is not a folder in the listing", () => {
  expect(readListing(PAGE_XML).prefixes).not.toContain("shop/");
});

// The quotes are part of the ETag.
test("an ETag comes back with its quotes and a key with its ampersand", () => {
  const page = readListing(PAGE_XML);

  expect(page.keys[0]!.version).toBe('"9b2cf5"');
  expect(page.keys[0]!.key).toBe("shop/a&b.csv");
});

test("a numeric escape is undone too", () => {
  const page = readListing(
    `<ListBucketResult><Contents><Key>a&#39;b&#x2F;c.csv</Key><Size>1</Size></Contents></ListBucketResult>`,
  );

  expect(page.keys[0]!.key).toBe("a'b/c.csv");
});

test("a truncated page carries where the next one starts", () => {
  const page = readListing(
    `<ListBucketResult><IsTruncated>true</IsTruncated>` +
      `<NextContinuationToken>1/opaque+token/==</NextContinuationToken></ListBucketResult>`,
  );

  expect(page.truncated).toBe(true);
  expect(page.next).toBe("1/opaque+token/==");
});

// `truncated` and `next` are reported separately.
test("a page truncated with no token says so rather than looking finished", () => {
  const page = readListing(`<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>`);

  expect(page.truncated).toBe(true);
  expect(page.next).toBeUndefined();
});

test("elements the reader was not written for are ignored", () => {
  const page = readListing(
    `<ListBucketResult><EncodingType>url</EncodingType>` +
      `<Contents><Key>a.csv</Key><Size>7</Size><Owner><ID>someone</ID></Owner></Contents>` +
      `</ListBucketResult>`,
  );

  expect(page.keys).toEqual([{ key: "a.csv", bytes: 7 }]);
});

// A Contents with an unreadable size or time is still a key.
test("a key whose size and time cannot be read is still a key", () => {
  const page = readListing(
    `<ListBucketResult><Contents><Key>a.csv</Key><Size>huge</Size>` +
      `<LastModified>whenever</LastModified></Contents></ListBucketResult>`,
  );

  expect(page.keys).toEqual([{ key: "a.csv" }]);
});

// ------------------------------------------------------------ addresses

test("a place in a bucket is read from either form, and a bucket root from s3://", () => {
  expect(s3Prefix("s3://acme-exports/shop/2025/")).toEqual({
    bucket: "acme-exports",
    prefix: "shop/2025/",
  });
  expect(s3Prefix("s3://acme-exports")).toEqual({ bucket: "acme-exports", prefix: "" });
  expect(s3Prefix("s3://acme-exports/")).toEqual({ bucket: "acme-exports", prefix: "" });
  expect(s3Prefix("https://acme-exports.s3.eu-west-1.amazonaws.com/shop/")).toEqual({
    bucket: "acme-exports",
    prefix: "shop/",
  });
  expect(s3Prefix("/home/jo/exports")).toBeUndefined();
  expect(s3Prefix("gs://acme-exports/shop/")).toBeUndefined();
});

test("the S3 lister claims places in a bucket and leaves disks alone", () => {
  const s3 = s3Lister({ credentials: () => Promise.resolve(KEYS) });

  expect(s3.handles("s3://acme-exports/shop/")).toBe(true);
  expect(s3.handles("s3://acme-exports")).toBe(true);
  expect(s3.handles("/home/jo/exports")).toBe(false);
  expect(s3.handles("C:\\Users\\jo")).toBe(false);
  expect(s3.handles("gs://acme-exports/")).toBe(false);
});

test("the S3 provider browses what it opens", () => {
  const s3 = s3Provider({ credentials: () => Promise.resolve(KEYS) });

  expect(s3.browse?.label).toBe("S3");
  expect(s3.browse?.handles("s3://acme-exports/shop/")).toBe(true);
});

// ------------------------------------------------------------ a bucket
//
// These run against standin.ts.

/** The one-byte body of most objects. */
const ONE = new Uint8Array([7]);

/**
 * The bucket every check below browses: a prefix with two folders and three
 * files in it, a zero-byte folder marker, the awkward keys from awkward.ts,
 * and a prefix of 2,500 keys.
 */
function objects(): Map<string, Uint8Array> {
  const all = new Map<string, Uint8Array>([
    ["2025/sales-q3.csv", bytes],
    // The folder marker: a zero-byte object whose key is the prefix itself.
    ["shop/", new Uint8Array()],
    ["shop/a&b.csv", ONE],
    ["shop/notes.txt", ONE],
    ["shop/zz.csv", ONE],
    ["shop/2025/orders-01.csv", ONE],
    ["shop/2025/orders-02.csv", ONE],
    ["shop/archive/old.csv", ONE],
  ]);
  for (const [key] of AWKWARD_KEYS) all.set(`odd/${key}`, bytes);
  for (const [key] of DOT_KEYS) all.set(`dots/${key}`, ONE);
  for (let i = 0; i < 2_500; i++) all.set(`big/key-${String(i).padStart(4, "0")}.csv`, ONE);
  return all;
}

function named(entries: Entry[]): string[] {
  return entries.map((e) => e.name);
}

describe("browsing a bucket", () => {
  let b: Bucket;
  beforeAll(async () => {
    b = await bucket(undefined, HOME_REGION, objects());
  });
  afterAll(() => b.close());

  const lister = () => s3Lister({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint });
  const handler = () => s3Files({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint });

  test("a prefix comes back folders first and then by name", async () => {
    const listing = await lister().list(`s3://${BUCKET}/shop/`);

    expect(named(listing.entries)).toEqual(["2025", "archive", "a&b.csv", "notes.txt", "zz.csv"]);
    expect(listing.entries.filter((e) => e.folder).map((e) => e.name)).toEqual(["2025", "archive"]);
    expect(listing.next, "one page holds a prefix this small").toBeUndefined();
  });

  // The marker's name is empty once the prefix is removed, and it is left
  // out.
  test("the folder marker is not listed beside the folder it made", async () => {
    const listing = await lister().list(`s3://${BUCKET}/shop/`);

    expect(named(listing.entries)).not.toContain("");
    expect(listing.entries.map((e) => e.path)).not.toContain(`s3://${BUCKET}/shop/`);
  });

  // A folder entry's path is the prefix to list next, slash included.
  test("a folder's path is one the lister browses", async () => {
    const s3 = lister();
    const shop = await s3.list(`s3://${BUCKET}/shop/`);
    const into = shop.entries.find((e) => e.name === "2025")!;

    expect(into.path).toBe(`s3://${BUCKET}/shop/2025/`);
    expect(into.bytes, "a prefix has no size to have").toBeUndefined();
    expect(named((await s3.list(into.path)).entries)).toEqual(["orders-01.csv", "orders-02.csv"]);
  });

  test("a listing carries the size and the version of every key", async () => {
    const { entries } = await lister().list(`s3://${BUCKET}/shop/`);
    const by = new Map(entries.map((e) => [e.name, e]));

    expect(by.get("notes.txt")!.bytes).toBe(ONE.length);
    expect(by.get("notes.txt")!.modified).toEqual(new Date(MODIFIED));
    // The version is the ETag from the listing.
    expect(by.get("notes.txt")!.version).toBe(etagOf(ONE));
    expect(by.get("2025")!.version, "a prefix has no version either").toBeUndefined();
  });

  test("a bucket root lists what is at the top of it", async () => {
    const listing = await lister().list(`s3://${BUCKET}`);

    expect(named(listing.entries)).toEqual(["2025", "big", "dots", "odd", "shop"]);
    expect(listing.entries.every((e) => e.folder)).toBe(true);
  });

  // 2,500 keys at a thousand a page.
  test("a prefix of 2,500 keys comes back in three pages", async () => {
    const s3 = lister();

    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await s3.list(`s3://${BUCKET}/big/`, cursor);
      pages.push(named(page.entries));
      cursor = page.next;
    } while (cursor !== undefined);

    expect(pages.map((p) => p.length)).toEqual([1_000, 1_000, 500]);
    expect(pages.flat()).toHaveLength(2_500);
    expect(new Set(pages.flat()).size, "no key on two pages").toBe(2_500);
    expect(pages.flat()[0]).toBe("key-0000.csv");
    expect(pages.flat().at(-1)).toBe("key-2499.csv");
  });

  // The token goes back as it came, encoded and signed.
  test("the bucket's continuation token goes back as it came", async () => {
    const s3 = lister();
    const first = await s3.list(`s3://${BUCKET}/big/`);
    expect(first.next).toBeDefined();

    b.seen.length = 0;
    const second = await s3.list(`s3://${BUCKET}/big/`, first.next);

    expect(second.entries[0]!.name).toBe("key-1000.csv");
    // `+`, `/` and `=` in the token are sent percent-encoded.
    const asked = b.seen.at(-1)!.query!;
    expect(asked).toContain("continuation-token=");
    expect(asked).not.toMatch(/continuation-token=[^&]*[+/=]/);
  });

  test("an empty prefix is an empty listing and not a failure", async () => {
    const listing = await lister().list(`s3://${BUCKET}/nothing-under-here/`);

    expect(listing.entries).toEqual([]);
    expect(listing.next).toBeUndefined();
  });

  // Every key in awkward.ts, listed and then opened from the listed path. A
  // key with a slash in it folds into a folder.
  test("an awkward key is listed under its own name and opens from that path", async () => {
    const { entries } = await lister().list(`s3://${BUCKET}/odd/`);
    const files = entries.filter((e) => !e.folder);
    const s3 = handler();

    expect(named(entries).toSorted()).toEqual(
      AWKWARD_KEYS.map(([key]) => (key.includes("/") ? key.split("/")[0]! : key)).toSorted(),
    );
    expect(named(entries.filter((e) => e.folder))).toEqual(["empty", "ventas-ñ"]);
    for (const entry of files) {
      const file = await s3.open({ name: entry.name, path: entry.path });
      expect(await file.read(0, 8), `${entry.path} opens`).toEqual(bytes.subarray(0, 8));
    }
  });

  // A listing follows the wrong-region redirect once and remembers the
  // region.
  test("a listing follows the bucket to its region once", async () => {
    const s3 = lister();
    b.seen.length = 0;

    await s3.list(`s3://${BUCKET}/shop/`);
    const first = b.seen.filter((r) => r.query?.includes("list-type") === true).length;
    await s3.list(`s3://${BUCKET}/shop/`);
    const both = b.seen.filter((r) => r.query?.includes("list-type") === true).length;

    expect(first, "the redirect, and then the listing").toBe(2);
    expect(both - first, "the second page knows where the bucket is").toBe(1);
  });

  test("says which bucket it cannot browse, and why", async () => {
    const wrong = s3Lister({
      credentials: () => Promise.resolve({ ...KEYS, secretAccessKey: "not it" }),
      endpoint: b.endpoint,
    });
    await expect(wrong.list(`s3://${BUCKET}/shop/`)).rejects.toThrow(
      "access denied · the AWS credentials uno found cannot list that bucket (s3:ListBucket)",
    );

    await expect(lister().list("s3://finance-lake/exports/")).rejects.toThrow(
      "s3://finance-lake/exports/: no such bucket",
    );
  });

  test("stat is the size and the version now, without reading the object", async () => {
    const one = await lister().stat(`s3://${BUCKET}/2025/sales-q3.csv`);

    expect(one.name).toBe("sales-q3.csv");
    expect(one.folder).toBe(false);
    expect(one.bytes).toBe(bytes.length);
    expect(one.version).toBe(etagOf(bytes));
    expect(one.path).toBe(`s3://${BUCKET}/2025/sales-q3.csv`);
  });

  test("a stat of something that is not there names it", async () => {
    await expect(lister().stat(`s3://${BUCKET}/2025/never-written.csv`)).rejects.toThrow(
      `s3://${BUCKET}/2025/never-written.csv: no such object in that bucket`,
    );
  });

  // A URL would collapse the segment before signing, so the key is refused.
  test("a key no URL can ask for is refused the same way by opening and by stat", async () => {
    const [key] = DOT_KEYS[0]!;
    const path = `s3://${BUCKET}/dots/${key}`;
    const said = "uno cannot address a key with a .. segment in it";

    await expect(handler().open({ name: "sales-q3.csv", path })).rejects.toThrow(said);
    await expect(lister().stat(path)).rejects.toThrow(said);
  });

  test("browsing something that is not a place in S3 fails naming it", async () => {
    await expect(lister().list("gs://acme-exports/shop/")).rejects.toThrow(
      "gs://acme-exports/shop/: not a place in S3",
    );
  });
});
