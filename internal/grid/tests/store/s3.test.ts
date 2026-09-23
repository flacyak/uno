// Reading a source out of S3.
//
// The signing is held to AWS's own published examples, because a signature
// that is wrong in one byte is a 403 and nothing more helpful. The rest runs
// against a small stand-in for S3 on localhost that serves the real fixture,
// checks every request's signature the way S3 would, and answers ranges.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { readContainer } from "../../src/document/index.ts";
import { EMPTY_SHA256, s3Files, s3Location, s3Url, signV4 } from "../../src/store/s3.ts";
import type { AwsCredentials } from "../../src/store/s3.ts";
import { awsCredentials, localFiles } from "../../src/store/node.ts";
import { bytes, connect, indexed, openOne, sales } from "../engine/harness.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import { AWKWARD_KEYS, DOT_KEYS } from "./awkward.ts";

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
  // fetch sets Host itself and throws if told to.
  expect(headers["host"]).toBeUndefined();
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

  test("refuse an SSO profile by name, with the command that gets around it", async () => {
    const env = {
      ...(await files("", "[profile work]\nsso_session = acme\nregion = us-east-1\n")),
      AWS_PROFILE: "work",
    };
    await expect(awsCredentials(env)()).rejects.toThrow(
      "aws configure export-credentials --profile work",
    );
  });

  test("say what to set when there are none", async () => {
    await expect(awsCredentials(await files(""))()).rejects.toThrow(/^no AWS credentials · set /);
  });
});

// ------------------------------------------------------------ a bucket

const KEYS: AwsCredentials = {
  accessKeyId: "AKIDUNOTEST",
  secretAccessKey: "uno/test/secret",
  region: "us-east-1",
};

/** Where the stand-in keeps its one bucket, and the region it says it is in. */
const BUCKET = "acme-exports";
const HOME_REGION = "eu-west-1";

interface Bucket {
  endpoint: string;
  /** Every request that reached it: the raw target too, for counting and for
   * checking that a key arrived on the wire exactly as it was written. */
  seen: Array<{ method: string; path: string; range: string | undefined }>;
  /** What each key holds. Change one to rewrite the object under a reader. */
  objects: Map<string, Uint8Array>;
  close(): Promise<void>;
}

/**
 * bucket is S3 as far as uno can tell: HEAD, ranged GET, If-Match, a redirect
 * for the wrong region, and a 403 for a signature that does not check out --
 * checked by signing the same request again with the same secret.
 */
async function bucket(): Promise<Bucket> {
  const objects = new Map<string, Uint8Array>([["2025/sales-q3.csv", bytes]]);
  const seen: Bucket["seen"] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const range = req.headers["range"];
    // req.url is the target as it was sent. Everything that looks at the path
    // works off this, because `new URL` would resolve away a `.` or `..`
    // segment that is part of a key's name.
    const raw = req.url!.split("?")[0]!;
    seen.push({ method: req.method!, path: raw, range });
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const auth = req.headers["authorization"] ?? "";
    const region = /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(auth)?.[1];

    // S3 checks the signature before anything else, and so does this.
    const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
    const again = signV4(
      {
        method: req.method!,
        url,
        headers: Object.fromEntries(
          signed
            .filter((h) => h !== "host" && h !== "x-amz-date")
            .map((h) => [h, String(req.headers[h])]),
        ),
      },
      KEYS,
      region ?? "",
      "s3",
      amzDate(String(req.headers["x-amz-date"])),
    );
    if (again["authorization"] !== auth) {
      res.writeHead(403).end();
      return;
    }
    if (region !== HOME_REGION) {
      res.writeHead(301, { "x-amz-bucket-region": HOME_REGION }).end();
      return;
    }

    const [, name, ...rest] = raw.split("/");
    const key = rest.map((seg) => decodeURIComponent(seg)).join("/");
    const body = name === BUCKET ? objects.get(key) : undefined;
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const etag = `"${body.length}-${body[0]}"`;
    if (req.headers["if-match"] !== undefined && req.headers["if-match"] !== etag) {
      res.writeHead(412).end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": body.length, etag }).end();
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    const part = m === null ? body : body.subarray(Number(m[1]), Number(m[2]) + 1);
    res.writeHead(m === null ? 200 : 206, { "content-length": part.length, etag }).end(part);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    objects,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A ref to an object in the stand-in's bucket. */
function at(key: string): { name: string; path: string } {
  return { name: key.slice(key.lastIndexOf("/") + 1), path: `s3://${BUCKET}/${key}` };
}

/** The date a request was signed at, back out of its x-amz-date. */
function amzDate(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s)!;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

describe("a source in a bucket", () => {
  let b: Bucket;
  beforeAll(async () => {
    b = await bucket();
  });
  afterAll(() => b.close());

  const handlers = () => [
    localFiles(),
    s3Files({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint }),
  ];

  test("opens as a view, read in ranges, and matches the file it is", async () => {
    const { engine, done } = connect(undefined, handlers());
    try {
      b.seen.length = 0;
      const src = await openOne(engine, {
        name: "sales-q3.csv",
        path: `s3://${BUCKET}/2025/sales-q3.csv`,
      });
      await indexed(src);

      expect(src.progress.rows).toBe(ROWS);
      expect(src.opened.link).toEqual({ path: `s3://${BUCKET}/2025/sales-q3.csv` });
      const rows = (await src.rows(100, 3)).rows;
      expect(rows.map((r) => r[UNITS])).toEqual([100, 101, 102].map((r) => sales.raw(r, UNITS)));

      // Nothing asked for the whole object: a HEAD for its size, then ranges.
      expect(b.seen[0]).toMatchObject({ method: "HEAD", range: undefined });
      expect(b.seen.filter((r) => r.method === "GET").every((r) => r.range !== undefined)).toBe(
        true,
      );
    } finally {
      done();
    }
  });

  // The bucket is in eu-west-1 and the credentials say us-east-1. S3 says so
  // once, and uno goes straight there after.
  test("follows the bucket to its region once", async () => {
    const { engine, done } = connect(undefined, handlers());
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

  // An export rewritten while it is being read would hand the index the front
  // of one file and the back of another. Asking for each range as the version
  // that was opened turns that into an error that says so.
  test("refuses to read an object rewritten under it", async () => {
    const s3 = s3Files({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint });
    b.objects.set("2025/moving.csv", bytes);
    const file = await s3.open(at("2025/moving.csv"));
    expect((await file.read(0, 4)).length).toBe(4);

    b.objects.set("2025/moving.csv", bytes.subarray(10));
    await expect(file.read(0, 4)).rejects.toThrow("changed in the bucket since it was opened");
  });

  // A remote pointer is never read relative to the workspace's folder, and a
  // save writes it down exactly as it was opened.
  test("saves as the URL it came from, and opens again from it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uno-s3-"));
    const url = `s3://${BUCKET}/2025/sales-q3.csv`;

    const first = connect(undefined, handlers());
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

    const second = connect(undefined, handlers());
    try {
      const src = await openOne(second.engine, { name: "q3.uno", path: join(dir, "q3.uno") });
      expect(src.opened.link).toEqual({ path: url });
      expect((await src.rows(0, 1)).rows[0]![UNITS]).toBe("1204");
    } finally {
      second.done();
    }
  });

  // The workspace opens on a machine that cannot reach the bucket. The source
  // is still there, edits and all, and says what stopped it.
  test("an engine with no S3 keeps the source and says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uno-s3-"));
    const first = connect(undefined, handlers());
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
      expect(src.opened.link?.missing).toContain("this build reads local files");
    } finally {
      local.done();
    }
  });
});

// ------------------------------------------------------------ awkward keys
//
// awkward.ts says what these keys are and why they are the ones that break.
// Here they are read out of the stand-in, which checks every signature the way
// S3 does and looks a key up by the path as it arrived, not as URL would
// rather have it.

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

  // If the encoding and the signature ever disagree the stand-in answers 403,
  // the same as S3 does, so reaching the bytes above already proves they agree.
  // This says what the encoding is, so a change to it is a change somebody
  // chose rather than one a runtime made on uno's behalf.
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
        // Refusing is a fine answer, as long as it names the key it refused.
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
    // A + in a path is a plus, not a space. Only a query string spells it that way.
    ["https://acme-exports.s3.amazonaws.com/2025/sales+q3.csv", "2025/sales+q3.csv"],
  ] as Array<[string, string]>) {
    expect(s3Location(url), url).toEqual({ bucket: "acme-exports", key: want });
  }

  // A pasted URL with a stray per cent is not an address uno can read, and
  // saying so is the handler's job. Throwing out of handles() takes down the
  // choice of handler for every source in the workspace, local ones included.
  for (const url of [
    "https://acme-exports.s3.amazonaws.com/2025/100%.csv",
    "https://s3.eu-west-1.amazonaws.com/acme-exports/50%off.csv",
    "https://example.com/100%.csv",
  ]) {
    expect(() => s3Location(url), url).not.toThrow();
  }
});

/** The bytes of a string, for objects whose content only has to be telling. */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
