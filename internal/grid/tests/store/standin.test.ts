// The stand-in's own tests.
//
// s3.test.ts is where uno is held to S3's behaviour, and it gets to assume the
// stand-in is S3. These are the other direction: the few things standin.ts
// promises to whoever starts it -- s3.test.ts, and the desktop smoke run --
// which have no test of their own over there because nothing there uses them.

import { expect, test } from "vite-plus/test";

import { awsCredentials, localFiles } from "../../src/store/node.ts";
import { s3Files } from "../../src/store/s3.ts";
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

// standinEnv is what points a process at the stand-in, and the environment it
// goes into is a developer's own: an AWS_PROFILE from some other afternoon, a
// session token that has been in the shell since lunch. Either one is enough to
// send a run that was meant for localhost at a real account, so what matters is
// not only what standinEnv sets but what it puts out of the way.
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

// And the environment reaches an object, rather than only parsing into the
// right credentials. Endpoint, keys and region all come out of standinEnv here,
// so a wrong name for any of them is a failed read and not a passing test.
test("reads an object out of the bucket that environment names", async () => {
  const b = await bucket();
  const env = standinEnv(b);
  const { engine, done } = connect(undefined, [
    localFiles(),
    s3Files({ credentials: awsCredentials(env), endpoint: env["AWS_ENDPOINT_URL_S3"] }),
  ]);
  try {
    const src = await openOne(engine, at("2025/sales-q3.csv"));
    await indexed(src);
    expect(src.progress.rows).toBe(ROWS);
    expect((await src.rows(100, 1)).rows[0]![UNITS]).toBe(sales.raw(100, UNITS));
    // Every byte came off the stand-in, signed for the region the environment
    // named, so nothing was redirected and nothing went to AWS instead.
    expect(b.seen[0]).toMatchObject({ method: "HEAD" });
    expect(b.seen.every((r) => r.region === HOME_REGION)).toBe(true);
  } finally {
    done();
    await b.close();
  }
});
