// A stand-in for S3, on localhost.
//
// It checks every request's signature the way S3 does, answers HEAD and
// ranged GET, lists a prefix the way ListObjectsV2 does, redirects a request
// signed for the wrong region, and serves objects out of a Map. Every test
// but s3.live.test.ts runs against it. The desktop smoke run starts the same
// server.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { compareStrings } from "../../src/go/index.ts";
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

/**
 * keysOnly is an environment holding the stand-in's keys only: the profile
 * cleared, and config paths that point at missing files.
 */
export function keysOnly(region: string = HOME_REGION): Record<string, string | undefined> {
  return {
    AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
    AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
    AWS_REGION: region,
    AWS_PROFILE: undefined,
    AWS_CONFIG_FILE: "/nonexistent/config",
    AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/credentials",
  };
}

/** The stand-in's default bucket. */
export const BUCKET = "acme-exports";

/** The LastModified stamp every object in the stand-in reports. */
export const MODIFIED = "2026-09-20T12:00:00.000Z";

/**
 * Beside is another bucket in the same stand-in: its objects and who may read
 * it. A bucket with keys answers only requests signed with those keys. A
 * public one answers unsigned requests.
 */
export interface Beside {
  objects: Map<string, Uint8Array>;
  keys?: AwsCredentials;
  public?: boolean;
  /**
   * Whether the bucket keeps every version of an object. Each answer carries
   * its version id, and a request with a VersionId is served that version
   * however the object has changed since.
   */
  versioned?: boolean;
}

/**
 * versionIdOf is the VersionId a versioned bucket gives a body: its MD5 in
 * base64, so the id holds `+`, `/` and `=`, which a request must encode and
 * sign as sent.
 */
export function versionIdOf(body: Uint8Array): string {
  return createHash("md5").update(body).digest("base64");
}

/**
 * etagOf is the ETag the stand-in gives an object: the MD5 of its bytes in
 * quotes, as S3 gives an object uploaded in one piece.
 */
export function etagOf(body: Uint8Array): string {
  let etag = etags.get(body);
  if (etag === undefined) {
    etag = `"${createHash("md5").update(body).digest("hex")}"`;
    etags.set(body, etag);
  }
  return etag;
}

/** Each body's ETag, computed once. */
const etags = new WeakMap<Uint8Array, string>();

/** The default wrong-region reply: a 301 with the x-amz-bucket-region header. */
export const MOVED: Misdirect = { status: 301, headers: { "x-amz-bucket-region": "$REGION" } };

export interface Bucket {
  endpoint: string;
  /** Every request that reached it, with the raw path and query as sent. */
  seen: Array<{
    method: string;
    path: string;
    query: string | undefined;
    range: string | undefined;
    region: string;
    /** The access key id it was signed with, or "" when unsigned. */
    key: string;
  }>;
  /** What each key holds. Change an entry to rewrite an object under a reader. */
  objects: Map<string, Uint8Array>;
  /** How long each answer waits before it is sent, in ms. 0 by default. */
  latency: number;
  close(): Promise<void>;
}

/**
 * bucket starts the stand-in: HEAD, ranged GET, If-Match, ListObjectsV2, a
 * redirect for the wrong region, and a 403 for a bad signature.
 *
 * A request signed for a region other than `home` is answered with
 * `misdirect`. `objects` are the default bucket's contents, and `beside`
 * adds other buckets.
 */
export async function bucket(
  misdirect: Misdirect = MOVED,
  home = HOME_REGION,
  objects: Map<string, Uint8Array> = new Map([["2025/sales-q3.csv", bytes]]),
  beside: Record<string, Beside> = {},
): Promise<Bucket> {
  const seen: Bucket["seen"] = [];
  /** Every bucket it holds. */
  const buckets = new Map<string, Beside>([
    [BUCKET, { objects, keys: KEYS }],
    ...Object.entries(beside),
  ]);
  /** Every body a versioned bucket has held under each key, by VersionId. */
  const history = new Map<string, Map<string, Uint8Array>>();
  /** remember records the current body of every key in a versioned bucket. */
  function remember(name: string, held: Beside): void {
    if (held.versioned !== true) return;
    for (const [key, body] of held.objects) {
      const at = `${name}/${key}`;
      if (!history.has(at)) history.set(at, new Map());
      history.get(at)!.set(versionIdOf(body), body);
    }
  }
  const secrets = new Map(
    [KEYS, ...Object.values(beside).flatMap((b) => (b.keys === undefined ? [] : [b.keys]))].map(
      (k) => [k.accessKeyId, k],
    ),
  );

  /** The latency a test set. */
  const live = { latency: 0 };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (live.latency > 0) setTimeout(() => answer(req, res), live.latency);
    else answer(req, res);
  });

  /** answer handles one request. */
  function answer(req: IncomingMessage, res: ServerResponse): void {
    const range = req.headers["range"];
    // The path is taken from req.url as sent. `new URL` would collapse a `.`
    // or `..` segment in a key.
    const raw = req.url!.split("?")[0]!;
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const auth = req.headers["authorization"] ?? "";
    const region = /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(auth)?.[1];
    const key = /Credential=([^/]+)\//.exec(auth)?.[1] ?? "";
    seen.push({
      method: req.method!,
      path: raw,
      query: req.url!.split("?")[1],
      range,
      region: region ?? "",
      key,
    });
    const [, name, ...rest] = raw.split("/");
    const held = buckets.get(name ?? "");
    if (held !== undefined) remember(name!, held);

    // An unsigned request is answered only by a public bucket.
    if (auth === "") {
      if (held?.public === true) {
        serve(held, name!, rest, url, req, res);
        return;
      }
      res.writeHead(403).end();
      return;
    }

    // The signature is checked before anything else.
    const signer = secrets.get(key);
    if (signer === undefined) {
      res.writeHead(403).end();
      return;
    }
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
      signer,
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
      // A HEAD reply carries headers only. content-length still says what a GET
      // would send.
      res.writeHead(away.status, {
        ...away.headers,
        "content-length": Buffer.byteLength(away.body),
      });
      res.end(req.method === "HEAD" ? undefined : away.body);
      return;
    }

    // A valid signature with keys foreign to the bucket.
    if (held !== undefined && held.public !== true && held.keys?.accessKeyId !== key) {
      res.writeHead(403).end();
      return;
    }
    if (held === undefined) {
      res.writeHead(404).end();
      return;
    }
    serve(held, name!, rest, url, req, res);
  }

  /** serve answers a request the bucket has let in. */
  function serve(
    held: Beside,
    name: string,
    rest: string[],
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const range = req.headers["range"];
    if (url.searchParams.has("list-type")) {
      // Only ListObjectsV2 is answered.
      if (url.searchParams.get("list-type") !== "2") {
        res.writeHead(400).end();
        return;
      }
      const body = listing(name, held.objects, url);
      res
        .writeHead(200, {
          "content-type": "application/xml",
          "content-length": Buffer.byteLength(body),
        })
        .end(body);
      return;
    }

    const key = rest.map((seg) => decodeURIComponent(seg)).join("/");
    // A HEAD of the bucket itself is HeadBucket, answered with the region.
    if (key === "" && req.method === "HEAD") {
      res.writeHead(200, { "x-amz-bucket-region": home }).end();
      return;
    }
    // A VersionId is served from history. An unversioned bucket refuses it.
    const asked = url.searchParams.get("versionId");
    if (asked !== null && held.versioned !== true) {
      res.writeHead(400).end();
      return;
    }
    const body = asked === null ? held.objects.get(key) : history.get(`${name}/${key}`)?.get(asked);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const etag = etagOf(body);
    const version: Record<string, string> =
      held.versioned === true ? { "x-amz-version-id": asked ?? versionIdOf(body) } : {};
    if (req.headers["if-match"] !== undefined && req.headers["if-match"] !== etag) {
      res.writeHead(412).end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": body.length, etag, ...version }).end();
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    const part = m === null ? body : body.subarray(Number(m[1]), Number(m[2]) + 1);
    res
      .writeHead(m === null ? 200 : 206, { "content-length": part.length, etag, ...version })
      .end(part);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    objects,
    get latency() {
      return live.latency;
    },
    set latency(ms: number) {
      live.latency = ms;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * listing is ListObjectsV2 over the Map: prefix, delimiter, max-keys and a
 * continuation token.
 *
 * Keys and the prefixes they fold into are one sorted sequence, and a page is
 * a window on it, so folders and keys stay interleaved across pages.
 * The token is the last item of the page in base64, which holds `+`, `/` and
 * `=` that a caller must send back encoded.
 */
function listing(name: string, objects: Map<string, Uint8Array>, url: URL): string {
  const prefix = url.searchParams.get("prefix") ?? "";
  const delimiter = url.searchParams.get("delimiter") ?? "";
  const max = Math.max(1, Number(url.searchParams.get("max-keys") ?? "1000"));
  const token = url.searchParams.get("continuation-token");
  const after = token === null ? "" : Buffer.from(token, "base64").toString("utf8");

  const items: string[] = [];
  // The items that are folded prefixes. A key ending in a slash, such as the
  // folder marker `shop/` listed under prefix `shop/`, stays a key.
  const folded = new Set<string>();
  for (const key of [...objects.keys()].toSorted(compareStrings)) {
    if (!key.startsWith(prefix)) continue;
    const cut = delimiter === "" ? -1 : key.indexOf(delimiter, prefix.length);
    const item = cut === -1 ? key : key.slice(0, cut + delimiter.length);
    if (cut !== -1) folded.add(item);
    // Keys are sorted, so keys folding into one prefix arrive together.
    if (items.at(-1) !== item) items.push(item);
  }

  const from = after === "" ? 0 : items.findIndex((i) => compareStrings(i, after) > 0);
  const page = from === -1 ? [] : items.slice(from, from + max);
  const more = from !== -1 && from + max < items.length;
  const last = page.at(-1);

  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `<Name>${xml(name)}</Name>`,
    `<Prefix>${xml(prefix)}</Prefix>`,
    `<Delimiter>${xml(delimiter)}</Delimiter>`,
    `<MaxKeys>${max}</MaxKeys>`,
    `<KeyCount>${page.length}</KeyCount>`,
    `<IsTruncated>${more}</IsTruncated>`,
  ];
  if (more && last !== undefined) {
    parts.push(
      `<NextContinuationToken>${xml(Buffer.from(last, "utf8").toString("base64"))}</NextContinuationToken>`,
    );
  }
  for (const item of page) {
    if (folded.has(item)) {
      parts.push(`<CommonPrefixes><Prefix>${xml(item)}</Prefix></CommonPrefixes>`);
      continue;
    }
    const body = objects.get(item)!;
    parts.push(
      `<Contents><Key>${xml(item)}</Key><LastModified>${MODIFIED}</LastModified>` +
        `<ETag>${xml(etagOf(body))}</ETag><Size>${body.length}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`,
    );
  }
  parts.push(`</ListBucketResult>`);
  return parts.join("");
}

/** xml escapes `&`, `<`, `>`, `"` and `'` for an XML body. */
function xml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

/** A ref to an object in the stand-in's bucket. */
export function at(key: string): { name: string; path: string } {
  return { name: key.slice(key.lastIndexOf("/") + 1), path: `s3://${BUCKET}/${key}` };
}

/** The Date an x-amz-date header names. */
export function amzDate(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s)!;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

/**
 * standinEnv is an environment that points an AWS-shaped tool at this bucket:
 * endpoint, keys and region. The undefined entries clear a profile or session
 * token the shell may carry, since an explicit undefined overwrites what was
 * there when spread over an inherited environment.
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
