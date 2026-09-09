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
//
// Browsing a bucket is store/s3lister.ts, beside this, the way the disk's two
// are store/node.ts and store/disklister.ts. What the two here share is the
// request rather than the syscall: `s3Requests` signs, retries and follows a
// bucket to its region, and the lister sends nothing of its own.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { Provider } from "../plugin/index.ts";
import type { FileHandler } from "./index.ts";
import { s3Lister } from "./s3lister.ts";

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
  // The path stays as it was pasted until a branch below knows what part of it
  // is the bucket and what part is the key, because where the bucket ends is a
  // question about the raw path: a %2F inside a bucket name is not the slash
  // that separates it from the key, and decoding first would make it look like
  // one. Decoding is per part, once the split has already happened.
  const path = u.pathname.slice(1);

  // bucket.s3.amazonaws.com, bucket.s3.us-west-2.amazonaws.com, bucket.s3-us-west-2.amazonaws.com
  const virtual = /^(.+)\.s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com$/.exec(u.hostname);
  if (virtual !== null) {
    if (path === "") return undefined;
    const key = decoded(path);
    return key === undefined ? undefined : { bucket: virtual[1]!, key };
  }

  // s3.amazonaws.com/bucket/key, s3.us-west-2.amazonaws.com/bucket/key
  if (
    /^s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com$/.test(u.hostname) ||
    u.hostname === "s3.amazonaws.com"
  ) {
    const slash = path.indexOf("/");
    if (slash <= 0 || slash === path.length - 1) return undefined;
    const bucket = decoded(path.slice(0, slash));
    const key = decoded(path.slice(slash + 1));
    if (bucket === undefined || key === undefined) return undefined;
    return { bucket, key };
  }
  return undefined;
}

/**
 * decoded undoes the %XX escaping of one part of an https URL, and answers
 * undefined when that part is not escaping uno can read.
 *
 * A key is allowed to hold a per cent sign, and a browser shows one that was
 * never escaped -- `100%.csv` -- so a pasted address is quite often not valid
 * escaping at all. decodeURIComponent raises URIError for those, and this is
 * reached from handles(), which is asked about every source in a workspace
 * before one of them is opened. A throw there is not a bad S3 URL, it is no
 * handler chosen for any source at all, local files included. So an address
 * uno cannot read is simply not an address uno claims.
 */
function decoded(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
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
 * How many times one request follows a bucket to another region. A bucket is
 * in one place, so being sent somewhere new twice over means the answers are
 * not about where the bucket is, and asking again only makes a loop.
 */
const MOVES = 1;
/**
 * How much of a refusal is read while looking for the region in it. The reply
 * that matters is a few hundred bytes; anything longer is something else, and
 * reading all of it is a download uno did not ask for.
 */
const REFUSAL_BYTES = 64 << 10;

/**
 * s3Provider is a bucket plugged in as one thing: the handler that opens an
 * object, and the lister that browses the prefix it came out of.
 *
 * The same module answers for every S3-compatible store -- R2, MinIO, Supabase
 * -- because they differ by endpoint and region and not by protocol, so they
 * are this provider with different options rather than providers of their own.
 */
export function s3Provider(opts: S3Options): Provider {
  return { name: "s3", label: "S3", files: s3Files(opts), browse: s3Lister(opts) };
}

/**
 * S3Requests is a signed request, retried, and followed to wherever the bucket
 * turns out to be: everything about asking S3 anything that is not about what
 * was asked for.
 *
 * It is out here rather than inside the handler because the lister needs every
 * word of it and none of it is about objects. A lister with its own copy of the
 * region redirect and the backoff would be a second one to keep right, and the
 * two would drift the way the two refusals in claim.ts had already begun to.
 */
export interface S3Requests {
  /** One object: HEAD for how big it is, GET for a range of it. */
  object(loc: S3Location, method: "HEAD" | "GET", extra: Record<string, string>): Promise<Response>;
  /** The bucket itself with a query on it, which is what a listing asks for. */
  bucket(bucket: string, query: Record<string, string>): Promise<Response>;
}

/**
 * s3Requests is the two ways uno asks a bucket anything, and one bucket's worth
 * of memory about where buckets are.
 *
 * s3Files and s3Lister each make their own, so a bucket in another region is
 * followed there once by each rather than once between them. That is one extra
 * round trip, the first time a workspace both opens and browses such a bucket,
 * and task 2.9 spends it once for good by storing the region in the connection.
 */
export function s3Requests(opts: S3Options): S3Requests {
  const go = opts.fetch ?? fetch;
  /** Where each bucket turned out to be, once it has said, so only the first
   * request to a bucket in another region pays for the redirect. */
  const regions = new Map<string, string>();

  /** One signed request, sent once, to wherever `at` says a region is asked. */
  async function send(
    at: (region: string) => URL,
    method: "HEAD" | "GET",
    extra: Record<string, string>,
    creds: AwsCredentials,
    region: string,
  ): Promise<Response> {
    const url = at(region);
    const headers = signV4(
      { method, url, headers: { ...extra, "x-amz-content-sha256": EMPTY_SHA256 } },
      creds,
      region,
      "s3",
      new Date(),
    );
    return go(url, { method, headers });
  }

  /**
   * request is `send` with the two things around it that every request to S3
   * needs: another try for what the network did, and one move to the region the
   * bucket says it is in.
   *
   * What is being asked for is a function of the region rather than a URL,
   * because the second attempt goes to a different host and asks the same
   * question, and a signature is only valid for the host it named.
   */
  async function request(
    bucket: string,
    at: (region: string) => URL,
    method: "HEAD" | "GET",
    extra: Record<string, string>,
  ): Promise<Response> {
    let moves = 0;
    for (let attempt = 1; ; attempt++) {
      const creds = await opts.credentials();
      const region = regions.get(bucket) ?? creds.region;

      let res: Response;
      try {
        res = await send(at, method, extra, creds, region);
      } catch (err) {
        if (attempt >= TRIES) throw err;
        await wait(BACKOFF_MS << (attempt - 1));
        continue;
      }

      // The bucket is somewhere other than where it was asked for. It says
      // where, once, and every request after goes straight there.
      if ((res.status === 301 || res.status === 400) && moves < MOVES) {
        const moved = await whereItWent(res, () =>
          // A reply to a HEAD carries no body, and a HEAD is what open() sends
          // first, so a bucket that only names its region in the body has to
          // be asked a way that can answer. One byte is enough of an ask: the
          // refusal comes back instead of the byte.
          send(at, "GET", { range: "bytes=0-0" }, creds, region),
        );
        if (moved !== undefined && moved !== region) {
          moves++;
          regions.set(bucket, moved);
          continue;
        }
      }
      if (res.status >= 500 && attempt < TRIES) {
        await wait(BACKOFF_MS << (attempt - 1));
        continue;
      }
      return res;
    }
  }

  return {
    object: (loc, method, extra) =>
      request(loc.bucket, (region) => objectUrl(loc, region, opts.endpoint), method, extra),
    // A listing is a GET, so its refusal carries a body, so the region in one
    // is there to be read without the extra ask a HEAD needs.
    bucket: (bucket, query) =>
      request(bucket, (region) => listUrl(bucket, query, region, opts.endpoint), "GET", {}),
  };
}

/**
 * s3Files opens objects in S3 for reading. It claims s3:// URLs and the https
 * URLs of objects on amazonaws.com.
 */
export function s3Files(opts: S3Options): FileHandler {
  const send = s3Requests(opts);

  return {
    label: "S3",
    handles: (ref) => "path" in ref && s3Location(ref.path) !== undefined,

    async open(ref) {
      const loc = "path" in ref ? s3Location(ref.path) : undefined;
      if (loc === undefined) throw new Error(`${ref.name}: not an object in S3`);
      const url = s3Url(loc);
      // Refused here, before a single request goes out, because the request
      // would be the wrong one and nothing downstream could tell.
      const cannot = unaddressable(loc);
      if (cannot !== undefined) throw cannot;

      const head = await send.object(loc, "HEAD", {});
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
          const res = await send.object(loc, "GET", {
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

/**
 * whereItWent reads a refusal for the region the bucket is actually in, and
 * answers undefined when the refusal does not name one uno can use.
 *
 * AWS says it in `x-amz-bucket-region` and that is the end of it. Everything
 * else -- an older PermanentRedirect, MinIO, R2, a proxy that drops headers it
 * does not recognise -- says it only in the XML body, and a bucket whose
 * refusal is never read is a bucket that cannot be opened at all, because
 * every request uno sends after the first is signed the same wrong way.
 *
 * The body is the least trustworthy thing in the exchange, though. The region
 * becomes a hostname, so a body that chooses it chooses where the next
 * request goes -- signed, with the session token on it. Hence isRegion: what
 * comes out of here is a word that can only ever be one label of the host uno
 * already meant to talk to.
 */
async function whereItWent(
  res: Response,
  probe: () => Promise<Response>,
): Promise<string | undefined> {
  const header = res.headers.get("x-amz-bucket-region");
  if (header !== null) return isRegion(header) ? header : undefined;

  let body = await refusalBody(res);
  if (body === "") {
    // Nothing to read, which is every HEAD. Ask again in a way that can carry
    // an answer. A probe that somehow succeeds is not a redirect at all.
    const again = await probe().catch(() => undefined);
    if (again === undefined) return undefined;
    if (again.ok) {
      await again.body?.cancel();
      return undefined;
    }
    body = await refusalBody(again);
  }
  return regionIn(body);
}

/** As much of a refusal as is worth reading, as text. */
async function refusalBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const parts: Uint8Array[] = [];
  let read = 0;
  try {
    while (read < REFUSAL_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
      read += next.value.length;
    }
  } catch {
    // A refusal that stops halfway is one uno cannot follow, which is the
    // same answer as a refusal that does not say where the bucket is.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(read);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * regionIn finds the region in the three places a refusal puts it: the
 * element, the sentence, and inside the endpoint it says to use instead.
 *
 * Each is asked in turn and the first to say anything is the answer, right or
 * wrong -- a reply that names a region uno cannot use is not one to keep
 * reading for a second opinion.
 */
function regionIn(xml: string): string | undefined {
  const element = /<Region>([^<]*)<\/Region>/i.exec(xml)?.[1];
  if (element !== undefined) return isRegion(element) ? element : undefined;

  // "the region 'us-east-1' is wrong; expecting 'eu-west-1'"
  const expecting = /expecting '([^']*)'/i.exec(xml)?.[1];
  if (expecting !== undefined) return isRegion(expecting) ? expecting : undefined;

  const endpoint = /<Endpoint>([^<]*)<\/Endpoint>/i.exec(xml)?.[1];
  return endpoint === undefined ? undefined : regionInHost(endpoint);
}

/**
 * regionInHost reads the region out of an endpoint, which is where a
 * PermanentRedirect keeps it: bucket.s3.eu-west-1.amazonaws.com, and the
 * s3-eu-west-1.amazonaws.com it was spelled as before 2019.
 *
 * s3.amazonaws.com names no region -- it is the global endpoint -- so it
 * answers undefined rather than guessing us-east-1.
 */
function regionInHost(host: string): string | undefined {
  const region = /(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i.exec(host.trim())?.[1];
  return region !== undefined && isRegion(region) ? region : undefined;
}

/**
 * isRegion says whether a word is shaped like one. It is the whole of the
 * defence around a region out of a body: what passes here is spliced into
 * `https://<bucket>.s3.<region>.amazonaws.com`, so it has to be a thing that
 * cannot end the host, open a path, or be a host of its own. Letters, digits
 * and inner hyphens do all of that. `auto`, which is what R2 signs as, is a
 * region by this reading, and it has to be.
 */
function isRegion(word: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(word);
}

/**
 * What S3's status codes mean to the person who pasted the URL.
 *
 * Shared with the lister's `stat`, which sends the same HEAD of the same object
 * and has to say the same thing about a 403 as opening it does.
 */
export function refusal(status: number): string {
  switch (status) {
    case 403:
      return "access denied · the AWS credentials uno found cannot read it";
    case 404:
      return "no such object in that bucket";
    default:
      return `S3 answered ${status}`;
  }
}

/**
 * unaddressable is the Error for a key no URL can ask for, and undefined for a
 * key uno can reach.
 *
 * Opening and statting both make this refusal, because both are about to turn a
 * key into a URL, and it is one function rather than two copies of a paragraph
 * for the reason claim.ts is one refusal: the copies had drifted once already.
 */
export function unaddressable(loc: S3Location): Error | undefined {
  const dot = dotSegment(loc.key);
  if (dot === undefined) return undefined;
  const url = s3Url(loc);
  return new Error(
    `${url}: uno cannot address a key with a ${dot} segment in it · S3 can hold one, ` +
      `but every URL on the way to it resolves the segment away, so the object that ` +
      `came back would be a different one · copy it to a key without ${dot} in a segment`,
  );
}

/**
 * dotSegment answers with the `.` or `..` segment a key carries, when it
 * carries one, so it can be named in the refusal.
 *
 * A key is any UTF-8 string, so `2025/quarterly/../sales-q3.csv` is a perfectly
 * ordinary name for an object and S3 will serve it. A URL is not a key though.
 * The WHATWG URL parser resolves dot segments while it parses, so `new URL` has
 * already turned that path into `2025/sales-q3.csv` by the time anything here
 * signs it -- and because the signature is then taken over the collapsed path,
 * S3 agrees with it and answers 200. There is no 403 to notice, just the wrong
 * object presented as the right one, which is the worst shape a bug can take in
 * something people read numbers out of.
 *
 * It cannot be spelled around. The URL spec matches `%2e` as a dot when it
 * looks for these segments, so `%2E%2E` collapses the same way, and `new
 * Request("https://h/a/../b").url` collapses too -- so fetch cannot be handed a
 * path it will leave alone either. Only a transport that writes the request
 * line itself could ask for such a key, and one more transport is a great deal
 * to carry for a key nobody meant to create. uno refuses instead, and says so.
 */
function dotSegment(key: string): string | undefined {
  return key.split("/").find((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

/**
 * bucketUrl is where a bucket is reached, which is the part an object and a
 * listing of one have in common.
 *
 * A dotted bucket name does not match the wildcard certificate on the
 * virtual-hosted name, so it goes path-style, and an endpoint is always
 * path-style: MinIO and a stand-in on localhost have no per-bucket hostname.
 */
function bucketUrl(bucket: string, region: string, endpoint: string | undefined): string {
  if (endpoint !== undefined && endpoint !== "") {
    return `${endpoint.replace(/\/+$/, "")}/${encodePath(bucket)}`;
  }
  if (bucket.includes(".")) return `https://s3.${region}.amazonaws.com/${bucket}`;
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

function objectUrl(loc: S3Location, region: string, endpoint: string | undefined): URL {
  return new URL(`${bucketUrl(loc.bucket, region, endpoint)}/${encodePath(loc.key)}`);
}

/**
 * listUrl is the bucket with a question on it: ListObjectsV2 is a GET of the
 * bucket root, and what is being asked is entirely in the query.
 *
 * The query is written here with `encode` rather than through `searchParams`,
 * because URLSearchParams serialises the way a form does -- a space becomes a
 * `+` -- and SigV4 signs the way RFC 3986 does, where it is `%20`. A prefix with
 * a space in it would be signed one way and sent another, which is a 403, and a
 * prefix with a `+` in it would list somebody else's folder.
 */
function listUrl(
  bucket: string,
  query: Record<string, string>,
  region: string,
  endpoint: string | undefined,
): URL {
  const asked = Object.entries(query)
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .join("&");
  return new URL(`${bucketUrl(bucket, region, endpoint)}/?${asked}`);
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
