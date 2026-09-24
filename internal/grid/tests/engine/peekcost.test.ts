// What a peek costs, against something that charges for it.
//
// peek.test.ts watches a source it wrote itself, which proves the module asks
// for one read and lets go of the file. That is the arithmetic. This is the
// bill: the same peek against a server that answers the way S3 does, and
// against a file that really is 2.5 GB.
//
// The number this is defending is one HEAD and one ranged GET, whatever the
// object weighs. It is the whole reason a panel can let somebody click down a
// folder of four hundred exports: the request that gets sent has nothing to do
// with what they landed on. A peek that read the object to find its rows would
// still pass every check in peek.test.ts and cost thirty gigabytes here.

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

/** The six columns every copy of the fixture has, however large the copy is. */
const COLUMNS = ["date", "region", "rep", "channel", "units", "revenue"];

// ------------------------------------------------------------ an object in a bucket

describe("a peek at an object in a bucket", () => {
  let b: Bucket;
  beforeAll(async () => {
    b = await bucket();
  });
  afterAll(() => b.close());

  // Signed for the region the bucket is in, so the one extra HEAD a redirect
  // costs is not in the way of counting. Following a bucket to its region is
  // s3.test.ts's business and happens once per handler, not once per peek.
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

  // The object in the stand-in is 240 KB and the one in the sentence above is
  // 30 GB. The requests are the same two requests, which is the claim.
  test("costs the same for an object many windows long", async () => {
    // The fixture end to end, twelve times: 2.9 MB, forty-four windows.
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
// times: 2.5 GB, too large to commit, and made by hand on the machines that
// want it. So this skips where it is absent rather than failing, and the
// synthetic 2.5 GB source in peek.test.ts is what CI holds the same promise
// with. When the file is there, this is the task's own check.

const HUGE = fileURLToPath(new URL("../testdata/generated/sales-q3-50m.csv", import.meta.url));

describe.skipIf(!existsSync(HUGE))("a peek at a 2.5 GB file on this disk", () => {
  test("reads 64 KB of it and returns its six headers", async () => {
    const size = (await stat(HUGE)).size;
    expect(size).toBeGreaterThan(2_000_000_000);

    const peeked = await peek([localFiles()], { name: "sales-q3-50m.csv", path: HUGE });

    expect(peeked.header).toEqual(COLUMNS);
    expect(peeked.rows).toHaveLength(20);
    expect(peeked.label).toBe("UTF-8 · delimiter ','");
  });
});
