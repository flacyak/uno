// locate: a connection's bucket region, found with a HeadBucket when the
// connection is made and kept in it.
//
// The stand-in lives in eu-west-1 and the credentials say us-east-1.

import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";

import type { Connection } from "../../src/library/index.ts";
import { formatConnection } from "../../src/library/index.ts";
import { connectionSigning, diskProvider } from "../../src/store/node.ts";
import { locate, s3Provider } from "../../src/store/s3.ts";
import type { S3Options } from "../../src/store/s3.ts";
import { connect, indexed, openOne } from "../engine/harness.ts";
import { HOME_REGION, REGION_FORMATS, rendered } from "./regions.ts";
import { BUCKET, KEYS, bucket, keysOnly } from "./standin.ts";
import type { Bucket } from "./standin.ts";

let b: Bucket;
let from = 0;
beforeAll(async () => {
  b = await bucket();
});
afterAll(() => b.close());
beforeEach(() => {
  from = b.seen.length;
});

/** What this test sent, as method, path and the region it was signed for. */
function sent(): string[] {
  return b.seen.slice(from).map((r) => `${r.method} ${r.path} ${r.region}`);
}

/** The machine's keys, with region us-east-1. */
const MACHINE = { ...KEYS, region: "us-east-1" };

function draft(region?: string): Connection {
  const c: Connection = {
    format: 1,
    id: "acme-exports",
    name: "ACME exports",
    provider: "s3",
    bucket: BUCKET,
    prefix: "2025/",
    auth: { mode: "machine" },
    created: undefined,
    modified: undefined,
  };
  if (region !== undefined) c.region = region;
  return c;
}

function options(endpoint = b.endpoint): S3Options {
  return { credentials: () => Promise.resolve(MACHINE), endpoint };
}

test("a bucket in another region is connected without typing its region", async () => {
  const c = await locate(draft(), options());
  expect(c.region).toBe(HOME_REGION);
  expect(JSON.parse(formatConnection(c))["region"]).toBe(HOME_REGION);
});

// One HeadBucket for the credentials' region, redirected once.
test("it costs a HeadBucket, followed once", async () => {
  await locate(draft(), options());
  expect(sent()).toEqual([`HEAD /${BUCKET}/ us-east-1`, `HEAD /${BUCKET}/ ${HOME_REGION}`]);
});

// A connection with its region set sends every request to that region.
// One still to find it pays one redirect.
test("a connection holding its region sends its first request straight there", async () => {
  const env = keysOnly("us-east-1");
  const ref = { name: "sales-q3.csv", path: `s3://${BUCKET}/2025/sales-q3.csv` };

  for (const [c, redirects] of [
    [await locate(draft(), options()), 0],
    [draft(), 1],
  ] as const) {
    from = b.seen.length;
    const s3 = s3Provider({ credentials: connectionSigning(() => [c], env), endpoint: b.endpoint });
    const { engine, done } = connect(undefined, [diskProvider(), s3]);
    try {
      await indexed(await openOne(engine, ref));
      const away = b.seen.slice(from).filter((r) => r.region !== HOME_REGION);
      expect(away, c.region ?? "no region").toHaveLength(redirects);
    } finally {
      done();
    }
  }
});

// A reply naming the region only in the body is followed too.
test("a bucket that says where it is only in a body is followed there too", async () => {
  const format = REGION_FORMATS.find(
    (f) => f.follow && f.reply.headers?.["x-amz-bucket-region"] === undefined,
  );
  expect(format, "regions.ts has a body-only format to follow").toBeDefined();
  const other = await bucket(format!.reply);
  try {
    expect((await locate(draft(), options(other.endpoint))).region).toBe(HOME_REGION);
    expect(rendered(format!.reply, HOME_REGION).body).toContain(HOME_REGION);
  } finally {
    await other.close();
  }
});

test("a bucket that is not there is said, and nothing is stored", async () => {
  await expect(locate({ ...draft(), bucket: "acme-nowhere" }, options())).rejects.toThrow(
    "s3://acme-nowhere: no such bucket",
  );
});
