// A stand-in for S3, on localhost.
//
// Reaching a real bucket costs credentials, a network and somebody's money, so
// nothing but s3.live.test.ts does it. Everything else runs against this: it
// checks every request's signature the way S3 does, answers ranges, redirects a
// request signed for the wrong region, and serves objects out of a Map. A test
// that reads bytes out of it has proved the signature was right, because a
// signature that is wrong in one byte gets a 403 here too.
//
// It lives beside the tests rather than inside one because the desktop smoke
// run starts the same server, and two stand-ins that drift apart would be two
// different S3s to be correct against.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { signV4 } from "../../src/store/s3.ts";
import type { AwsCredentials } from "../../src/store/s3.ts";
import { bytes } from "../testdata/sales-q3.ts";
import { HOME_REGION, rendered } from "./regions.ts";
import type { Misdirect } from "./regions.ts";

export const KEYS: AwsCredentials = {
  accessKeyId: "AKIDUNOTEST",
  secretAccessKey: "uno/test/secret",
  region: "us-east-1",
};

/** Where the stand-in keeps its one bucket. regions.ts says which region. */
export const BUCKET = "acme-exports";

/** How the stand-in turns a request away by default: the way AWS does it. */
export const MOVED: Misdirect = { status: 301, headers: { "x-amz-bucket-region": "$REGION" } };

export interface Bucket {
  endpoint: string;
  /** Every request that reached it: the raw target too, for counting and for
   * checking that a key arrived on the wire exactly as it was written. */
  seen: Array<{ method: string; path: string; range: string | undefined; region: string }>;
  /** What each key holds. Change one to rewrite the object under a reader. */
  objects: Map<string, Uint8Array>;
  close(): Promise<void>;
}

/**
 * bucket is S3 as far as uno can tell: HEAD, ranged GET, If-Match, a redirect
 * for the wrong region, and a 403 for a signature that does not check out --
 * checked by signing the same request again with the same secret.
 *
 * It turns a request signed for the wrong region away with `misdirect`, which
 * is how AWS does it unless a test says otherwise, and lives in `home`. It
 * serves `objects`, which a caller hands in when the fixture under its usual
 * key is not what the run is about.
 */
export async function bucket(
  misdirect: Misdirect = MOVED,
  home = HOME_REGION,
  objects: Map<string, Uint8Array> = new Map([["2025/sales-q3.csv", bytes]]),
): Promise<Bucket> {
  const seen: Bucket["seen"] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const range = req.headers["range"];
    // req.url is the target as it was sent. Everything that looks at the path
    // works off this, because `new URL` would resolve away a `.` or `..`
    // segment that is part of a key's name.
    const raw = req.url!.split("?")[0]!;
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const auth = req.headers["authorization"] ?? "";
    const region = /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(auth)?.[1];
    seen.push({ method: req.method!, path: raw, range, region: region ?? "" });

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
    if (region !== home) {
      const away = rendered(misdirect, home);
      // A reply to a HEAD carries no body however the server writes it, so a
      // region that is only in the body cannot reach a HEAD at all. Node
      // drops it for us; content-length still says what a GET would send.
      res.writeHead(away.status, {
        ...away.headers,
        "content-length": Buffer.byteLength(away.body),
      });
      res.end(req.method === "HEAD" ? undefined : away.body);
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
export function at(key: string): { name: string; path: string } {
  return { name: key.slice(key.lastIndexOf("/") + 1), path: `s3://${BUCKET}/${key}` };
}

/** The date a request was signed at, back out of its x-amz-date. */
export function amzDate(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s)!;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

/**
 * standinEnv is the environment that points an AWS-shaped tool at this bucket:
 * a process uno starts, a CLI a smoke run drives, uno itself.
 *
 * The undefined entries are as much the point as the keys. A developer's shell
 * carries an AWS_PROFILE and often a session token left over from something
 * else, and either one gets to decide which credentials a run signs with --
 * so a run meant for localhost reaches a real account, or fails in a way that
 * reads like uno's fault. Spreading this over an inherited environment clears
 * them, because an explicit undefined overwrites what was there.
 */
export function standinEnv(b: Bucket, home = HOME_REGION): Record<string, string | undefined> {
  return {
    AWS_ENDPOINT_URL_S3: b.endpoint,
    AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
    AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
    AWS_REGION: home,
    AWS_PROFILE: undefined,
    AWS_DEFAULT_PROFILE: undefined,
    AWS_SESSION_TOKEN: undefined,
  };
}
