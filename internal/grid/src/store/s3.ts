// Reading a file out of an S3 bucket a piece at a time.
//
// The engine asks a source for its size and for byte ranges, and S3 answers
// exactly those two questions: HEAD for the size, GET with a Range header for
// the bytes. So an export in a bucket opens the way one on a disk does -- an
// index pass reads it front to back in chunks, the grid reads pages out of the
// middle -- and a 30 GB object costs the requests the person actually scrolls
// through, not a download.
//
// Requests are signed with SigV4 here, over the hashes the container already
// uses, rather than through the AWS SDK. Two operations is all uno needs, and
// the SDK for them would outweigh the whole of the rest of the engine.
//
// Nothing here knows where credentials come from. The caller hands in a
// function that produces them, so a desktop can read ~/.aws in its engine
// process and the renderer never holds a key.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { FileHandler } from "./index.ts";

/** Credentials and the region to sign for when a bucket has not said otherwise. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** For temporary credentials: an assumed role, an SSO session exported to env. */
  sessionToken?: string;
  region: string;
}

export interface S3Options {
  /**
   * Asked before every request, so credentials that rotate -- a session token
   * that expires in the middle of indexing 30 GB -- are picked up without
   * reopening anything. Whoever supplies them is the one to cache.
   */
  credentials: () => Promise<AwsCredentials>;
  /**
   * An S3-compatible endpoint to use instead of AWS: MinIO, a local stand-in
   * for tests. Requests to it are path-style, `<endpoint>/<bucket>/<key>`.
   */
  endpoint?: string;
  /** How requests go out. Defaults to the runtime's own fetch. */
  fetch?: typeof fetch;
}

/** Where an object is, whichever way its URL was written. */
export interface S3Location {
  bucket: string;
  key: string;
}

/**
 * s3Location reads the ways people paste an object's address: the s3:// form
 * the console and the CLI give, and the https forms a browser shows. Undefined
 * for anything that is not one of them.
 */
export function s3Location(url: string): S3Location | undefined {
  const s3 = /^s3:\/\/([^/]+)\/(.+)$/i.exec(url.trim());
  if (s3 !== null) return { bucket: s3[1]!, key: s3[2]! };

  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:") return undefined;
  const path = decodeURIComponent(u.pathname.slice(1));

  // bucket.s3.amazonaws.com, bucket.s3.us-west-2.amazonaws.com, bucket.s3-us-west-2.amazonaws.com
  const virtual = /^(.+)\.s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com$/.exec(u.hostname);
  if (virtual !== null) return path === "" ? undefined : { bucket: virtual[1]!, key: path };

  // s3.amazonaws.com/bucket/key, s3.us-west-2.amazonaws.com/bucket/key
  if (
    /^s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com$/.test(u.hostname) ||
    u.hostname === "s3.amazonaws.com"
  ) {
    const slash = path.indexOf("/");
    if (slash <= 0 || slash === path.length - 1) return undefined;
    return { bucket: path.slice(0, slash), key: path.slice(slash + 1) };
  }
  return undefined;
}

/** s3Url is the one form a .uno writes down, whichever form was pasted. */
export function s3Url(loc: S3Location): string {
  return `s3://${loc.bucket}/${loc.key}`;
}

/** How many times a request that failed on the network or with a 5xx is tried. */
const TRIES = 3;
/** The wait before the second try. It doubles for the third. */
const BACKOFF_MS = 200;

/**
 * s3Files opens objects in S3 for reading. It claims s3:// URLs and the https
 * URLs of objects on amazonaws.com.
 */
export function s3Files(opts: S3Options): FileHandler {
  const go = opts.fetch ?? fetch;
  /** Where each bucket turned out to be, once it has said, so only the first
   * request to a bucket in another region pays for the redirect. */
  const regions = new Map<string, string>();

  async function request(
    loc: S3Location,
    method: "HEAD" | "GET",
    extra: Record<string, string>,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const creds = await opts.credentials();
      const region = regions.get(loc.bucket) ?? creds.region;
      const url = objectUrl(loc, region, opts.endpoint);
      const headers = signV4(
        { method, url, headers: { ...extra, "x-amz-content-sha256": EMPTY_SHA256 } },
        creds,
        region,
        "s3",
        new Date(),
      );

      let res: Response;
      try {
        res = await go(url, { method, headers });
      } catch (err) {
        if (attempt >= TRIES) throw err;
        await wait(BACKOFF_MS << (attempt - 1));
        continue;
      }

      // The bucket is somewhere other than where it was asked for. S3 says
      // where, once, and every request after goes straight there.
      const moved = res.headers.get("x-amz-bucket-region");
      if ((res.status === 301 || res.status === 400) && moved !== null && moved !== region) {
        regions.set(loc.bucket, moved);
        continue;
      }
      if (res.status >= 500 && attempt < TRIES) {
        await wait(BACKOFF_MS << (attempt - 1));
        continue;
      }
      return res;
    }
  }

  return {
    label: "S3",
    handles: (ref) => "path" in ref && s3Location(ref.path) !== undefined,

    async open(ref) {
      const loc = "path" in ref ? s3Location(ref.path) : undefined;
      if (loc === undefined) throw new Error(`${ref.name}: not an object in S3`);
      const url = s3Url(loc);

      const head = await request(loc, "HEAD", {});
      if (!head.ok) throw new Error(`${url}: ${refusal(head.status)}`);
      const size = Number(head.headers.get("content-length") ?? "NaN");
      if (!Number.isFinite(size)) throw new Error(`${url}: S3 did not say how big it is`);
      // Every range after this one is asked for as this version of the object.
      // An export rewritten while it is being read would otherwise hand the
      // index the first half of one file and the second half of another.
      const etag = head.headers.get("etag");

      return {
        size,
        async read(offset, length) {
          const end = Math.min(offset + length, size);
          if (end <= offset) return new Uint8Array();
          const res = await request(loc, "GET", {
            range: `bytes=${offset}-${end - 1}`,
            ...(etag === null ? {} : { "if-match": etag }),
          });
          if (res.status === 412) {
            throw new Error(`${url} changed in the bucket since it was opened · open it again`);
          }
          if (!res.ok) throw new Error(`${url}: ${refusal(res.status)}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          // A server that ignored the range sent the whole object.
          return res.status === 200 && bytes.length === size ? bytes.subarray(offset, end) : bytes;
        },
        close: () => Promise.resolve(),
      };
    },
  };
}

/** What S3's status codes mean to the person who pasted the URL. */
function refusal(status: number): string {
  switch (status) {
    case 403:
      return "access denied · the AWS credentials uno found cannot read it";
    case 404:
      return "no such object in that bucket";
    default:
      return `S3 answered ${status}`;
  }
}

function objectUrl(loc: S3Location, region: string, endpoint: string | undefined): URL {
  const key = encodePath(loc.key);
  if (endpoint !== undefined && endpoint !== "") {
    return new URL(`${endpoint.replace(/\/+$/, "")}/${encodePath(loc.bucket)}/${key}`);
  }
  // A dotted bucket name does not match the wildcard certificate on the
  // virtual-hosted name, so it goes path-style.
  if (loc.bucket.includes(".")) {
    return new URL(`https://s3.${region}.amazonaws.com/${loc.bucket}/${key}`);
  }
  return new URL(`https://${loc.bucket}.s3.${region}.amazonaws.com/${key}`);
}

// ------------------------------------------------------------------ SigV4

/** The hash of an empty body, which is every body uno ever sends. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Unsigned {
  method: string;
  url: URL;
  /** Everything to sign besides host and the date, which are added here. */
  headers: Record<string, string>;
}

/**
 * signV4 returns the headers that authorise a request: the ones it was given,
 * plus host, the date, the session token where there is one, and the
 * Authorization line over all of them.
 *
 * The body is always empty, so its hash is fixed. Everything else follows
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 * step for step, and the tests hold it to AWS's own published examples.
 */
export function signV4(
  req: Unsigned,
  creds: Omit<AwsCredentials, "region">,
  region: string,
  service: string,
  now: Date,
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  headers["host"] = req.url.host;
  headers["x-amz-date"] = amzDate;
  if (creds.sessionToken !== undefined && creds.sessionToken !== "") {
    headers["x-amz-security-token"] = creds.sessionToken;
  }

  const names = Object.keys(headers).sort();
  const signed = names.join(";");
  const canonical = [
    req.method,
    req.url.pathname === "" ? "/" : req.url.pathname,
    canonicalQuery(req.url),
    names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join(""),
    signed,
    headers["x-amz-content-sha256"] ?? EMPTY_SHA256,
  ].join("\n");

  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");

  let key = mac(utf8ToBytes(`AWS4${creds.secretAccessKey}`), day);
  for (const part of [region, service, "aws4_request"]) key = mac(key, part);
  const signature = bytesToHex(mac(key, toSign));

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signed}, Signature=${signature}`;
  // fetch sets Host itself and refuses to be told.
  delete headers["host"];
  return headers;
}

function mac(key: Uint8Array, text: string): Uint8Array {
  return hmac(sha256, key, utf8ToBytes(text));
}

function hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join("&");
}

/** encodePath encodes each segment of a key as SigV4 wants it, keeping the slashes. */
function encodePath(key: string): string {
  return key.split("/").map(encode).join("/");
}

/** RFC 3986 unreserved characters stay; everything else is %XX, which is
 * stricter than encodeURIComponent about !'()*. */
function encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
