// Reading a source out of S3.
//
// Signing is checked against AWS's published examples. Everything else runs
// against standin.ts, which serves the fixture, checks every signature, and
// answers ranges.

import { createHash, createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { readContainer } from "../../src/document/index.ts";
import {
  EMPTY_SHA256,
  encode,
  s3Files,
  s3Location,
  s3Provider,
  s3Url,
  signV4,
} from "../../src/store/s3.ts";
import { awsCredentials, diskProvider } from "../../src/store/node.ts";
import { bytes, connect, indexed, openOne, sales, saidIn } from "../engine/harness.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import { AWKWARD_KEYS, DOT_KEYS } from "./awkward.ts";
import { HOME_REGION, REGION_FORMATS } from "./regions.ts";
import { at, BUCKET, bucket, etagOf, KEYS } from "./standin.ts";
import type { Bucket } from "./standin.ts";

// ------------------------------------------------------------ signing

// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-signing-examples.html
// and the get-vanilla case from the SigV4 test suite.
test("signs the SigV4 test suite's get-vanilla the way AWS does", () => {
  const headers = signV4(
    { method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {} },
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    "us-east-1",
    "service",
    new Date("2015-08-30T12:36:00Z"),
  );
  expect(headers["authorization"]).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html,
// "Example: GET Object": the first ten bytes of test.txt.
test("signs S3's documented ranged GET the way S3 does", () => {
  const headers = signV4(
    {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256 },
    },
    {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    "us-east-1",
    "s3",
    new Date("2013-05-24T00:00:00Z"),
  );
  expect(headers["authorization"]).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  // fetch sets Host itself, so the signer leaves it out.
  expect(headers["host"]).toBeUndefined();
});

/** The documented S3 account, and the moment every example on that page is signed at. */
const EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const EXAMPLE_DAY = new Date("2013-05-24T00:00:00Z");
/** sha256 of "Welcome to Amazon S3.", the body of the documented PUT. */
const WELCOME_SHA256 = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";

function signatureOf(headers: Record<string, string>): string | undefined {
  return /Signature=([0-9a-f]{64})$/.exec(headers["authorization"] ?? "")?.[1];
}

// The other three examples on the same page. The PUT signs a real body hash
// and a `$` in the key, the lifecycle GET a query of a bare name,
// and the listing a query of two names that have to come out in order.
interface Example {
  example: string;
  method: string;
  target: string;
  headers: Record<string, string>;
  signed: string;
  signature: string;
}
const EXAMPLES: Example[] = [
  {
    example: "PUT Object",
    method: "PUT",
    target: "/test%24file.text",
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
      "x-amz-content-sha256": WELCOME_SHA256,
    },
    signed: "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
    signature: "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  },
  {
    example: "GET Bucket Lifecycle",
    method: "GET",
    target: "/?lifecycle",
    headers: { "x-amz-content-sha256": EMPTY_SHA256 },
    signed: "host;x-amz-content-sha256;x-amz-date",
    signature: "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
  },
  {
    example: "Get Bucket (List Objects)",
    method: "GET",
    target: "/?max-keys=2&prefix=J",
    headers: { "x-amz-content-sha256": EMPTY_SHA256 },
    signed: "host;x-amz-content-sha256;x-amz-date",
    signature: "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  },
];
test.each(EXAMPLES)(
  "signs S3's documented $example the way S3 does",
  ({ method, target, headers, signed, signature }) => {
    const got = signV4(
      { method, url: new URL(`https://examplebucket.s3.amazonaws.com${target}`), headers },
      EXAMPLE,
      "us-east-1",
      "s3",
      EXAMPLE_DAY,
    );
    expect(got["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        `SignedHeaders=${signed}, Signature=${signature}`,
    );
  },
);

/**
 * reference is the SigV4 signature of a canonical request written out by
 * hand, computed with node's crypto alone.
 */
function reference(canonical: string, amzDate: string, scope: string, secret: string): string {
  const mac = (key: Buffer | string, text: string): Buffer =>
    createHmac("sha256", key).update(text).digest();
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let key = mac(`AWS4${secret}`, amzDate.slice(0, 8));
  for (const part of scope.split("/").slice(1)) key = mac(key, part);
  return mac(key, toSign).toString("hex");
}

// Query names are sorted before any value is looked at, so `prefix` comes
// before `prefix-x` although `=` sorts after `-`.
test("sorts a query by name first, then by value", () => {
  const url = new URL("https://examplebucket.s3.amazonaws.com/?prefix-x=1&prefix=J&prefix=A");
  const got = signV4(
    { method: "GET", url, headers: { "x-amz-content-sha256": EMPTY_SHA256 } },
    EXAMPLE,
    "us-east-1",
    "s3",
    EXAMPLE_DAY,
  );
  const canonical = [
    "GET",
    "/",
    "prefix=A&prefix=J&prefix-x=1",
    "host:examplebucket.s3.amazonaws.com",
    `x-amz-content-sha256:${EMPTY_SHA256}`,
    "x-amz-date:20130524T000000Z",
    "",
    "host;x-amz-content-sha256;x-amz-date",
    EMPTY_SHA256,
  ].join("\n");
  expect(signatureOf(got)).toBe(
    reference(
      canonical,
      "20130524T000000Z",
      "20130524/us-east-1/s3/aws4_request",
      EXAMPLE.secretAccessKey,
    ),
  );
});

// A host with a port, a session token, an awkward key, a versionId with `/`
// and `+`, and the last moment of a day: the host keeps its port, the token
// is signed, each segment is encoded once, and the scope date is the day of
// the x-amz-date.
test("signs a session's request to a stand-in on a port, for an awkward key, at the end of a day", () => {
  const key = "a b+c*d~e!f'g(h)i%j/k ü";
  const url = new URL(
    `http://localhost:9000/acme-exports/${key.split("/").map(encode).join("/")}` +
      `?versionId=${encode("x/y+z=")}`,
  );
  const got = signV4(
    { method: "GET", url, headers: { "x-amz-content-sha256": EMPTY_SHA256, Range: " bytes=0-9 " } },
    { ...EXAMPLE, sessionToken: "FwoGZXIvYXdzEBYaD/+token==" },
    "eu-west-1",
    "s3",
    new Date("2013-05-24T23:59:59.999Z"),
  );
  const canonical = [
    "GET",
    "/acme-exports/a%20b%2Bc%2Ad~e%21f%27g%28h%29i%25j/k%20%C3%BC",
    "versionId=x%2Fy%2Bz%3D",
    "host:localhost:9000",
    "range:bytes=0-9",
    `x-amz-content-sha256:${EMPTY_SHA256}`,
    "x-amz-date:20130524T235959Z",
    "x-amz-security-token:FwoGZXIvYXdzEBYaD/+token==",
    "",
    "host;range;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    EMPTY_SHA256,
  ].join("\n");
  expect(got["x-amz-security-token"]).toBe("FwoGZXIvYXdzEBYaD/+token==");
  expect(got["authorization"]).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/eu-west-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date;x-amz-security-token, " +
      `Signature=${reference(canonical, "20130524T235959Z", "20130524/eu-west-1/s3/aws4_request", EXAMPLE.secretAccessKey)}`,
  );
});

// ------------------------------------------------------------ addresses

test("reads every way an object's address gets pasted", () => {
  const want = { bucket: "acme-exports", key: "2025/q3/sales q3.csv" };
  for (const url of [
    "s3://acme-exports/2025/q3/sales q3.csv",
    "https://acme-exports.s3.amazonaws.com/2025/q3/sales%20q3.csv",
    "https://acme-exports.s3.eu-west-1.amazonaws.com/2025/q3/sales%20q3.csv",
    "https://acme-exports.s3-eu-west-1.amazonaws.com/2025/q3/sales%20q3.csv",
    "https://s3.eu-west-1.amazonaws.com/acme-exports/2025/q3/sales%20q3.csv",
    "  s3://acme-exports/2025/q3/sales q3.csv  ",
  ]) {
    expect(s3Location(url), url).toEqual(want);
  }
  expect(s3Url(want)).toBe("s3://acme-exports/2025/q3/sales q3.csv");
});

test("refuses what is not an object in S3", () => {
  for (const url of [
    "/home/cpa/sales.csv",
    "C:\\books\\sales.csv",
    "s3://acme-exports",
    "s3://acme-exports/",
    "http://acme-exports.s3.amazonaws.com/sales.csv",
    "https://example.com/sales.csv",
    "https://s3.amazonaws.com/acme-exports",
  ]) {
    expect(s3Location(url), url).toBeUndefined();
  }
});

// ------------------------------------------------------------ credentials

describe("credentials", () => {
  async function files(credentials: string, config = ""): Promise<Record<string, string>> {
    const dir = await mkdtemp(join(tmpdir(), "uno-aws-"));
    await writeFile(join(dir, "credentials"), credentials);
    await writeFile(join(dir, "config"), config);
    return {
      AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
      AWS_CONFIG_FILE: join(dir, "config"),
    };
  }

  test("come from the environment first", async () => {
    const env = {
      ...(await files("[default]\naws_access_key_id = FROMFILE\naws_secret_access_key = x\n")),
      AWS_ACCESS_KEY_ID: "FROMENV",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "eu-west-1",
    };
    expect(await awsCredentials(env)()).toEqual({
      accessKeyId: "FROMENV",
      secretAccessKey: "secret",
      sessionToken: "token",
      region: "eu-west-1",
    });
  });

  test("then from the profile AWS_PROFILE names, with its region from config", async () => {
    const env = {
      ...(await files(
        "[default]\naws_access_key_id = DEFAULT\naws_secret_access_key = a\n\n" +
          "[books]\naws_access_key_id = BOOKS\naws_secret_access_key = b\n",
        "[profile books]\nregion = ap-southeast-2\n",
      )),
      AWS_PROFILE: "books",
    };
    expect(await awsCredentials(env)()).toMatchObject({
      accessKeyId: "BOOKS",
      secretAccessKey: "b",
      region: "ap-southeast-2",
    });
  });

  // SSO is covered in sso.test.ts. Here, a missing sso-session is refused by
  // name.
  test("refuse an SSO profile whose sso-session is not in the config", async () => {
    const env = {
      ...(await files("", "[profile work]\nsso_session = acme\nregion = us-east-1\n")),
      AWS_PROFILE: "work",
    };
    await expect(awsCredentials(env)()).rejects.toThrow(
      "the AWS profile work names sso-session acme, which ~/.aws/config does not have",
    );
  });

  test("say what to set when there are none", async () => {
    await expect(awsCredentials(await files(""))()).rejects.toThrow(/^no AWS credentials · set /);
  });
});

// ------------------------------------------------------------ a bucket
//
// These run against standin.ts.

describe("a source in a bucket", () => {
  let b: Bucket;
  beforeAll(async () => {
    b = await bucket();
  });
  afterAll(() => b.close());

  const providers = () => [
    diskProvider(),
    s3Provider({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint }),
  ];

  test("opens as a view, read in ranges, and matches the file it is", async () => {
    const { engine, done } = connect(undefined, providers());
    try {
      b.seen.length = 0;
      const src = await openOne(engine, {
        name: "sales-q3.csv",
        path: `s3://${BUCKET}/2025/sales-q3.csv`,
      });
      await indexed(src);

      expect(src.progress.rows).toBe(ROWS);
      // The link carries the path and the version read.
      expect(src.opened.link).toEqual({
        path: `s3://${BUCKET}/2025/sales-q3.csv`,
        version: etagOf(bytes),
      });
      const rows = (await src.rows(100, 3)).rows;
      expect(rows.map((r) => r[UNITS])).toEqual([100, 101, 102].map((r) => sales.raw(r, UNITS)));

      // Every request was a HEAD for its size or a GET of a range.
      expect(b.seen[0]).toMatchObject({ method: "HEAD", range: undefined });
      expect(b.seen.filter((r) => r.method === "GET").every((r) => r.range !== undefined)).toBe(
        true,
      );
    } finally {
      done();
    }
  });

  // The bucket is in eu-west-1 and the credentials say us-east-1.
  test("follows the bucket to its region once", async () => {
    const { engine, done } = connect(undefined, providers());
    try {
      b.seen.length = 0;
      await openOne(engine, { name: "sales-q3.csv", path: `s3://${BUCKET}/2025/sales-q3.csv` });
      const redirects = b.seen.filter((r) => r.method === "HEAD").length - 1;
      expect(redirects).toBe(1);
    } finally {
      done();
    }
  });

  test("says which object it cannot reach, and why", async () => {
    const wrong = s3Files({
      credentials: () => Promise.resolve({ ...KEYS, secretAccessKey: "not it" }),
      endpoint: b.endpoint,
    });
    await expect(wrong.open(at("2025/sales-q3.csv"))).rejects.toThrow(
      `s3://${BUCKET}/2025/sales-q3.csv: access denied`,
    );

    const right = s3Files({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint });
    await expect(right.open(at("2025/gone.csv"))).rejects.toThrow("no such object in that bucket");
  });

  // Each range is asked for with If-Match on the version that was opened.
  test("refuses to read an object rewritten under it", async () => {
    const s3 = s3Files({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint });
    b.objects.set("2025/moving.csv", bytes);
    const file = await s3.open(at("2025/moving.csv"));
    expect((await file.read(0, 4)).length).toBe(4);

    b.objects.set("2025/moving.csv", bytes.subarray(10));
    await expect(file.read(0, 4)).rejects.toThrow("changed in the bucket since it was opened");
  });

  // The saved path is the URL as it was opened.
  test("saves as the URL it came from, and opens again from it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uno-s3-"));
    const url = `s3://${BUCKET}/2025/sales-q3.csv`;

    const first = connect(undefined, providers());
    let uno: Uint8Array;
    try {
      const src = await openOne(first.engine, { name: "sales-q3.csv", path: url });
      first.engine.mode(true);
      await src.edit({ op: "set", row: 0, col: UNITS, now: "1204" });
      uno = await first.engine.save(
        { source: src.id, cells: [], at: join(dir, "q3.uno") },
        1 << 20,
      );
    } finally {
      first.done();
    }
    expect(readContainer("q3.uno", uno).manifest.sources[0]!.path).toBe(url);
    await writeFile(join(dir, "q3.uno"), uno);

    const second = connect(undefined, providers());
    try {
      const src = await openOne(second.engine, { name: "q3.uno", path: join(dir, "q3.uno") });
      expect(src.opened.link).toEqual({ path: url, version: etagOf(bytes) });
      expect((await src.rows(0, 1)).rows[0]![UNITS]).toBe("1204");
    } finally {
      second.done();
    }
  });

  // Opened on a bare engine, the source is kept and reports what is missing.
  test("an engine with no S3 keeps the source and says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uno-s3-"));
    const first = connect(undefined, providers());
    let uno: Uint8Array;
    try {
      const src = await openOne(first.engine, {
        name: "sales-q3.csv",
        path: `s3://${BUCKET}/2025/sales-q3.csv`,
      });
      uno = await first.engine.save(
        { source: src.id, cells: [], at: join(dir, "q3.uno") },
        1 << 20,
      );
    } finally {
      first.done();
    }
    await writeFile(join(dir, "q3.uno"), uno);

    const local = connect();
    try {
      const src = await openOne(local.engine, { name: "q3.uno", path: join(dir, "q3.uno") });
      expect(saidIn(src.opened.link?.missing)).toContain("this build reads local files");
    } finally {
      local.done();
    }
  });
});

// ------------------------------------------------------------ awkward keys
//
// The keys in awkward.ts, read out of the stand-in, which looks a key up by
// the path as it arrived.

describe("awkward keys", () => {
  let b: Bucket;
  beforeAll(async () => {
    b = await bucket();
    for (const [key] of AWKWARD_KEYS) b.objects.set(`2025/${key}`, utf8(`the object at ${key}`));
  });
  afterAll(() => b.close());

  const s3 = () => s3Files({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint });

  /** Everything the handler gives back for a key, as text. */
  async function readAll(key: string): Promise<string> {
    const file = await s3().open(at(key));
    const text = new TextDecoder().decode(await file.read(0, file.size));
    await file.close();
    return text;
  }

  test("open every one of them, and give back the object that was asked for", async () => {
    for (const [key] of AWKWARD_KEYS) {
      expect(await readAll(`2025/${key}`), key).toBe(`the object at ${key}`);
    }
  });

  // The path on the wire is the encoded form awkward.ts gives.
  test("go out encoded once, and reach the wire that way", async () => {
    for (const [key, encoded] of AWKWARD_KEYS) {
      b.seen.length = 0;
      await readAll(`2025/${key}`);
      expect(b.seen.length, key).toBeGreaterThan(0);
      for (const req of b.seen) expect(req.path, key).toBe(`/${BUCKET}/2025/${encoded}`);
    }
  });

  test("survive the round trip through the URL a .uno writes down", () => {
    for (const [key] of AWKWARD_KEYS) {
      const loc = { bucket: BUCKET, key: `2025/${key}` };
      expect(s3Location(s3Url(loc)), key).toEqual(loc);
    }
  });

  test("never quietly read the object a dot segment collapses onto", async () => {
    for (const [key, onto] of DOT_KEYS) {
      b.objects.set(key, utf8(`the object at ${key}`));
      b.objects.set(onto, utf8(`the object at ${onto}`));
      const got = await readAll(key).catch((err: unknown) => err as Error);
      if (got instanceof Error) {
        // A refusal must name the key.
        expect(got.message, key).toContain(key);
      } else {
        expect(got, key).toBe(`the object at ${key}`);
      }
    }
  });
});

test("reads awkward keys out of the https forms too, and never throws", () => {
  for (const [url, want] of [
    ["https://acme-exports.s3.amazonaws.com/2025/sales%2Bq3.csv", "2025/sales+q3.csv"],
    ["https://acme-exports.s3.amazonaws.com/2025/100%25.csv", "2025/100%.csv"],
    ["https://acme-exports.s3.amazonaws.com/2025/ventas-%C3%B1.csv", "2025/ventas-ñ.csv"],
    ["https://acme-exports.s3.amazonaws.com/2025//double.csv", "2025//double.csv"],
    // A + in a path is a plus. Only a query string spells a space that way.
    ["https://acme-exports.s3.amazonaws.com/2025/sales+q3.csv", "2025/sales+q3.csv"],
  ] as Array<[string, string]>) {
    expect(s3Location(url), url).toEqual({ bucket: "acme-exports", key: want });
  }

  // A URL with a bad percent escape returns undefined.
  for (const url of [
    "https://acme-exports.s3.amazonaws.com/2025/100%.csv",
    "https://s3.eu-west-1.amazonaws.com/acme-exports/50%off.csv",
    "https://example.com/100%.csv",
  ]) {
    expect(() => s3Location(url), url).not.toThrow();
  }
});

// ------------------------------------------------------------ elsewhere
//
// Each reply in regions.ts, served by the stand-in. Reaching the object
// proves the second attempt was signed for the region it was sent to.

describe("a bucket that is somewhere else", () => {
  const where = (b: Bucket) =>
    s3Files({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint });

  for (const format of REGION_FORMATS) {
    test(`${format.follow ? "follows" : "refuses"} ${format.name}`, async () => {
      const home = format.home ?? HOME_REGION;
      const b = await bucket(format.reply, home);
      try {
        const opening = where(b).open(at("2025/sales-q3.csv"));
        if (!format.follow) {
          await expect(opening, format.name).rejects.toThrow();
          // Every request was signed for the credentials' own region.
          for (const r of b.seen) expect(r.region, format.name).toBe(KEYS.region);
          return;
        }
        expect((await opening).size, format.name).toBe(bytes.length);
        // At most three requests: the HEAD, a probe, and the HEAD again.
        expect(b.seen.length, format.name).toBeLessThanOrEqual(3);
        expect(b.seen.at(-1)?.region, format.name).toBe(home);
      } finally {
        await b.close();
      }
    });
  }

  // The region is remembered, so the second object costs one request.
  test("remembers it, so the next object in the bucket goes straight there", async () => {
    const b = await bucket(REGION_FORMATS[0]!.reply);
    try {
      b.objects.set("2025/other.csv", bytes);
      const s3 = where(b);
      await s3.open(at("2025/sales-q3.csv"));
      b.seen.length = 0;
      await s3.open(at("2025/other.csv"));
      expect(b.seen.map((r) => r.region)).toEqual([HOME_REGION]);
    } finally {
      await b.close();
    }
  });

  // A HEAD reply carries headers only, so the region is read from a one-byte
  // GET probe.
  test("asks a way that can carry the answer, since a HEAD cannot", async () => {
    const b = await bucket(REGION_FORMATS[0]!.reply);
    try {
      await where(b).open(at("2025/sales-q3.csv"));
      const probe = b.seen.find((r) => r.method === "GET" && r.region === KEYS.region);
      expect(probe, "the region came from somewhere a body could reach").toBeDefined();
      // And the probe asked for as little as it could.
      expect(probe?.range).toBe("bytes=0-0");
    } finally {
      await b.close();
    }
  });
});

// These use a stand-in fetch and the default endpoint, so the host uno builds
// is what is checked.
describe("a region out of a body never becomes a host", () => {
  /**
   * A fetch that answers every request with a 400 from `body`, records each
   * URL sent, and throws after eight requests.
   */
  function refusing(body: (n: number) => string) {
    const sent: URL[] = [];
    const go: typeof fetch = (input) => {
      sent.push(new URL(input as URL));
      if (sent.length > 8) throw new Error("gave up: uno is still following it");
      return Promise.resolve(
        new Response(body(sent.length), {
          status: 400,
          headers: { "content-type": "application/xml" },
        }),
      );
    };
    return { sent, s3: s3Files({ credentials: () => Promise.resolve(KEYS), fetch: go }) };
  }

  test("refuses a body that names a host instead of a region", async () => {
    const { sent, s3 } = refusing(
      () =>
        "<Error><Code>AuthorizationHeaderMalformed</Code>" +
        "<Region>elsewhere.example.com</Region></Error>",
    );
    await expect(s3.open(at("2025/sales-q3.csv"))).rejects.toThrow();
    for (const url of sent) expect(url.host).toBe(`${BUCKET}.s3.${KEYS.region}.amazonaws.com`);
  });

  // A reply naming a new region every time is followed a bounded number of
  // times.
  test("stops following a bucket that keeps moving", async () => {
    const { sent, s3 } = refusing(
      (n) =>
        `<Error><Code>AuthorizationHeaderMalformed</Code><Region>ap-southeast-${n}</Region></Error>`,
    );
    await expect(s3.open(at("2025/sales-q3.csv"))).rejects.toThrow(/400|region/);
    expect(sent.length).toBeLessThanOrEqual(4);
  });
});

/** The UTF-8 bytes of a string. */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
