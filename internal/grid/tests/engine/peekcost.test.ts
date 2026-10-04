// What a peek costs in requests: one HEAD and one ranged GET of PEEK_BYTES,
// against a stand-in S3 bucket and, where present, a 2.5 GB file on disk.

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { PEEK_BYTES, peek } from "../../src/engine/peek.ts";
import { localFiles } from "../../src/store/node.ts";
import { s3Files } from "../../src/store/s3.ts";
import { HOME_REGION } from "../store/regions.ts";
import { KEYS, at, bucket } from "../store/standin.ts";
import type { Bucket } from "../store/standin.ts";
import { bytes } from "../testdata/sales-q3.ts";
import { saidIn } from "./harness.ts";

/** The fixture's six columns. */
const COLUMNS = ["date", "region", "rep", "channel", "units", "revenue"];

// ------------------------------------------------------------ an object in a bucket

describe("a peek at an object in a bucket", () => {
  let b: Bucket;
  beforeAll(async () => {
    b = await bucket();
  });
  afterAll(() => b.close());

  // Signed for the bucket's own region, so every request lands first time.
  const s3 = () =>
    s3Files({
      credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
      endpoint: b.endpoint,
    });

  test("costs one HEAD and one ranged GET of 64 KB, and nothing else", async () => {
    const files = s3();
    b.seen.length = 0;

    const peeked = await peek([files], at("2025/sales-q3.csv"));

    expect(peeked.header).toEqual(COLUMNS);
    expect(peeked.rows).toHaveLength(20);
    expect(b.seen.map((r) => ({ method: r.method, range: r.range }))).toEqual([
      { method: "HEAD", range: undefined },
      { method: "GET", range: `bytes=0-${PEEK_BYTES - 1}` },
    ]);
  });

  test("costs the same for an object many windows long", async () => {
    // The fixture twelve times over: 2.9 MB.
    const big = new Uint8Array(bytes.length * 12);
    for (let at = 0; at < big.length; at += bytes.length) big.set(bytes, at);

    const other = await bucket(undefined, HOME_REGION, new Map([["2025/big.csv", big]]));
    try {
      const files = s3Files({
        credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
        endpoint: other.endpoint,
      });
      other.seen.length = 0;

      const peeked = await peek([files], {
        name: "big.csv",
        path: `s3://acme-exports/2025/big.csv`,
      });

      expect(peeked.header).toEqual(COLUMNS);
      expect(peeked.rows).toHaveLength(20);
      expect(other.seen.map((r) => ({ method: r.method, range: r.range }))).toEqual([
        { method: "HEAD", range: undefined },
        { method: "GET", range: `bytes=0-${PEEK_BYTES - 1}` },
      ]);
    } finally {
      await other.close();
    }
  });
});

// ------------------------------------------------------------ 2.5 GB on a disk
//
// tests/testdata/generated/sales-q3-50m.csv is sales-q3.csv repeated 10,400
// times. It is generated locally, so this is skipped where it is absent.

const HUGE = fileURLToPath(new URL("../testdata/generated/sales-q3-50m.csv", import.meta.url));

describe.skipIf(!existsSync(HUGE))("a peek at a 2.5 GB file on this disk", () => {
  test("reads 64 KB of it and returns its six headers", async () => {
    const size = (await stat(HUGE)).size;
    expect(size).toBeGreaterThan(2_000_000_000);

    const peeked = await peek([localFiles()], { name: "sales-q3-50m.csv", path: HUGE });

    expect(peeked.header).toEqual(COLUMNS);
    expect(peeked.rows).toHaveLength(20);
    expect(saidIn(peeked.label)).toBe("UTF-8 · delimiter ','");
  });
});
