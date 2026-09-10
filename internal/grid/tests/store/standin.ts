// A stand-in for S3, on localhost.
//
// Reaching a real bucket costs credentials, a network and somebody's money, so
// nothing but s3.live.test.ts does it. Everything else runs against this: it
// checks every request's signature the way S3 does, answers ranges, lists a
// prefix the way ListObjectsV2 does, redirects a request signed for the wrong
// region, and serves objects out of a Map. A test that reads bytes out of it has
// proved the signature was right, because a signature that is wrong in one byte
// gets a 403 here too.
//
// It lives beside the tests rather than inside one because the desktop smoke
// run starts the same server, and two stand-ins that drift apart would be two
// different S3s to be correct against.

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

/** Where the stand-in keeps its one bucket. regions.ts says which region. */
export const BUCKET = "acme-exports";

/**
 * When every object in the stand-in was last written.
 *
 * One stamp for all of them, so a test can say what a listing's `modified` has
 * to be rather than that it is a Date of some kind.
 */
export const MODIFIED = "2026-09-20T12:00:00.000Z";

/**
 * Beside is another bucket in the same stand-in: its own objects, and who may
 * read it. A bucket with keys answers only a request signed with those keys,
 * the way a bucket policy naming one role does, and a public one answers a
 * request with no signature at all.
 */
export interface Beside {
  objects: Map<string, Uint8Array>;
  keys?: AwsCredentials;
  public?: boolean;
}

/** How the stand-in turns a request away by default: the way AWS does it. */
export const MOVED: Misdirect = { status: 301, headers: { "x-amz-bucket-region": "$REGION" } };

export interface Bucket {
  endpoint: string;
  /** Every request that reached it: the raw target too, for counting and for
   * checking that a key arrived on the wire exactly as it was written, and the
   * raw query, which is the whole of what a listing asked for. */
  seen: Array<{
    method: string;
    path: string;
    query: string | undefined;
    range: string | undefined;
    region: string;
    /** The access key id it was signed with, or "" for a request not signed at all. */
    key: string;
  }>;
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
  beside: Record<string, Beside> = {},
): Promise<Bucket> {
  const seen: Bucket["seen"] = [];
  /** Every bucket it holds, and every key it knows the secret of. */
  const buckets = new Map<string, Beside>([
    [BUCKET, { objects, keys: KEYS }],
    ...Object.entries(beside),
  ]);
  const secrets = new Map(
    [KEYS, ...Object.values(beside).flatMap((b) => (b.keys === undefined ? [] : [b.keys]))].map(
      (k) => [k.accessKeyId, k],
    ),
  );

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const range = req.headers["range"];
    // req.url is the target as it was sent. Everything that looks at the path
    // works off this, because `new URL` would resolve away a `.` or `..`
    // segment that is part of a key's name.
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

    // A request with no signature is somebody reading a public bucket, and
    // nothing else is ever answered without one.
    if (auth === "") {
      if (held?.public === true) {
        serve(held, name!, rest, url, req, res);
        return;
      }
      res.writeHead(403).end();
      return;
    }

    // S3 checks the signature before anything else, and so does this.
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

    // A good signature from somebody the bucket does not let in: a real key,
    // for another bucket.
    if (held !== undefined && held.public !== true && held.keys?.accessKeyId !== key) {
      res.writeHead(403).end();
      return;
    }
    if (held === undefined) {
      res.writeHead(404).end();
      return;
    }
    serve(held, name!, rest, url, req, res);
  });

  /** What a bucket answers, once the request is one it lets in. */
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
      // Anything but ListObjectsV2 is a request this stand-in has never been
      // asked to answer, and answering it with an empty listing would let a
      // caller that asked for the wrong thing look like it worked.
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
    const body = held.objects.get(key);
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
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    objects,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * listing is ListObjectsV2 over the Map: a prefix, a delimiter, max-keys, and a
 * continuation token, paged the one way S3 pages.
 *
 * Keys and the prefixes they fold into are one sequence in one order, and the
 * page is a window on that sequence -- which is why a listing cannot promise
 * folders first across pages, and why this is modelled rather than answered in
 * whatever order was convenient.
 *
 * The token is the last item of the page in base64, which is not what AWS puts
 * in one but is the same shape of thing: opaque, and full of the characters --
 * `+`, `/`, `=` -- that a caller has to send back in a signed query without
 * rewriting any of them.
 */
function listing(name: string, objects: Map<string, Uint8Array>, url: URL): string {
  const prefix = url.searchParams.get("prefix") ?? "";
  const delimiter = url.searchParams.get("delimiter") ?? "";
  const max = Math.max(1, Number(url.searchParams.get("max-keys") ?? "1000"));
  const token = url.searchParams.get("continuation-token");
  const after = token === null ? "" : Buffer.from(token, "base64").toString("utf8");

  const items: string[] = [];
  // Which of them are prefixes rather than keys. It is whether the key was
  // folded and not whether it ends in a slash: the marker object a console
  // leaves behind is called `shop/`, and listing `shop/` has no delimiter left
  // after the prefix to fold it on, so S3 hands that one back as a key.
  const folded = new Set<string>();
  for (const key of [...objects.keys()].toSorted(compareStrings)) {
    if (!key.startsWith(prefix)) continue;
    const cut = delimiter === "" ? -1 : key.indexOf(delimiter, prefix.length);
    const item = cut === -1 ? key : key.slice(0, cut + delimiter.length);
    if (cut !== -1) folded.add(item);
    // Sorted, so every key that folds into one prefix arrives in a run.
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
        `<ETag>${xml(`"${body.length}-${body[0]}"`)}</ETag><Size>${body.length}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`,
    );
  }
  parts.push(`</ListBucketResult>`);
  return parts.join("");
}

/**
 * xml escapes what XML cannot carry raw.
 *
 * A key is any UTF-8 string, so `a&b.csv` and a quoted ETag both have to go out
 * escaped -- which is the half of the reply the reader has to undo, and a
 * stand-in that skipped it would never let it prove that it does.
 */
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
