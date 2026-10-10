// Tests of the stand-in itself: what standin.ts promises to s3.test.ts and
// the desktop smoke run.

import { expect, test } from "vite-plus/test";

import { awsCredentials, diskProvider } from "../../src/store/node.ts";
import { s3Files, s3Provider } from "../../src/store/s3.ts";
import { bytes, connect, indexed, openOne, sales } from "../engine/harness.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import { HOME_REGION } from "./regions.ts";
import { at, bucket, KEYS, standinEnv } from "./standin.ts";

/** A handler pointed at a bucket, with the keys it accepts. */
const reader = (endpoint: string) =>
  s3Files({ credentials: () => Promise.resolve(KEYS), endpoint });

test("serves the objects it was handed instead of the fixture", async () => {
  const b = await bucket(undefined, undefined, new Map([["2025/ledger.csv", bytes]]));
  try {
    const s3 = reader(b.endpoint);
    expect((await s3.open(at("2025/ledger.csv"))).size).toBe(bytes.length);
    await expect(s3.open(at("2025/sales-q3.csv"))).rejects.toThrow("no such object in that bucket");
  } finally {
    await b.close();
  }
});

// standinEnv sets the keys and clears the profile and session token a shell
// may carry.
test("hands out an environment that signs as the stand-in, whatever the shell says", async () => {
  const b = await bucket();
  try {
    const want = {
      accessKeyId: KEYS.accessKeyId,
      secretAccessKey: KEYS.secretAccessKey,
      sessionToken: undefined,
      region: HOME_REGION,
    };
    expect(standinEnv(b)["AWS_ENDPOINT_URL_S3"]).toBe(b.endpoint);
    expect(await awsCredentials(standinEnv(b))()).toEqual(want);

    const shell = {
      AWS_PROFILE: "work",
      AWS_DEFAULT_PROFILE: "work",
      AWS_SESSION_TOKEN: "a token from this morning",
      AWS_ACCESS_KEY_ID: "AKIDSOMEBODYSREAL",
      AWS_SECRET_ACCESS_KEY: "the real one",
      AWS_REGION: "ap-southeast-2",
    };
    expect(await awsCredentials({ ...shell, ...standinEnv(b) })()).toEqual(want);
  } finally {
    await b.close();
  }
});

// Endpoint, keys and region all come from standinEnv.
test("reads an object out of the bucket that environment names", async () => {
  const b = await bucket();
  const env = standinEnv(b);
  const { engine, done } = connect(undefined, [
    diskProvider(),
    s3Provider({ credentials: awsCredentials(env), endpoint: env["AWS_ENDPOINT_URL_S3"] }),
  ]);
  try {
    const src = await openOne(engine, at("2025/sales-q3.csv"));
    await indexed(src);
    expect(src.progress.rows).toBe(ROWS);
    expect((await src.rows(100, 1)).rows[0]![UNITS]).toBe(sales.raw(100, UNITS));
    // Every request was signed for the environment's region and went
    // straight through.
    expect(b.seen[0]).toMatchObject({ method: "HEAD" });
    expect(b.seen.every((r) => r.region === HOME_REGION)).toBe(true);
  } finally {
    done();
    await b.close();
  }
});
