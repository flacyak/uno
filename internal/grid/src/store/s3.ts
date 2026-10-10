// Reading an object out of an S3 bucket a range at a time: HEAD for the
// size, GET with a Range header for the bytes.
//
// Requests are signed with SigV4 here. Credentials come from a function the
// caller hands in. `s3Requests` signs, retries and follows a bucket to its
// region, and store/s3lister.ts sends its requests through it too.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { compareStrings, concat } from "../go/index.ts";
import type { Connection } from "../library/index.ts";
import { covering } from "../library/index.ts";
import type { Provider } from "../plugin/index.ts";
import type { FileHandler } from "./index.ts";
import { readAhead } from "./ahead.ts";
import { s3Lister } from "./s3lister.ts";

/** Credentials, and the region to sign for until a bucket says otherwise. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Set for temporary credentials. */
  sessionToken?: string;
  region: string;
  /**
   * Whose these are, for an error message: "the AWS profile finance". Absent
   * for what the machine's chain found, which an error calls "the AWS
   * credentials uno found".
   */
  as?: string;
}

/** Anonymous is a request sent unsigned, in a region. */
export interface Anonymous {
  readonly unsigned: true;
  region: string;
  as?: string;
}

/** How one request goes out: signed with credentials, or anonymous. */
export type Signing = AwsCredentials | Anonymous;

/** What a refusal calls credentials whose `as` is absent. */
const FOUND = "the AWS credentials uno found";

export interface S3Options {
  /**
   * Called before every request with where the request is going, so rotated
   * credentials are picked up and two buckets in one workspace can sign in
   * differently. The caller is the one to cache.
   */
  credentials: (loc: S3Location) => Promise<Signing>;
  /**
   * An S3-compatible endpoint that replaces AWS: MinIO, a local stand-in
   * for tests. Requests to it are path-style, `<endpoint>/<bucket>/<key>`.
   */
  endpoint?: string;
  /** How requests go out. Defaults to the runtime's own fetch. */
  fetch?: typeof fetch;
  /**
   * How many chunks a sequential reader has in flight at once, the one it
   * waits on included. AHEAD by default. 1 reads one at a time.
   */
  ahead?: number;
}

/** Where an object is, whichever way its URL was written. */
export interface S3Location {
  bucket: string;
  key: string;
}

/**
 * s3Location reads an object's address: the s3:// form, and the https forms
 * on amazonaws.com. Undefined for anything else.
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
  // The raw path is split before any part of it is decoded, since a %2F in
  // the bucket name is part of the name, and only a plain slash separates
  // bucket and key.
  const path = u.pathname.slice(1);

  // The bucket is in the host (bucket.s3.amazonaws.com/key,
  // bucket.s3.us-west-2.amazonaws.com/key,
  // bucket.s3-us-west-2.amazonaws.com/key) or the path's first segment
  // (s3.amazonaws.com/bucket/key, s3.us-west-2.amazonaws.com/bucket/key).
  const host = /^(?:(.+)\.)?s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com$/.exec(u.hostname);
  if (host === null || path === "") return undefined;
  const named = host[1];
  if (named !== undefined) {
    const key = decoded(path);
    return key === undefined ? undefined : { bucket: named, key };
  }
  const slash = path.indexOf("/");
  if (slash <= 0 || slash === path.length - 1) return undefined;
  const bucket = decoded(path.slice(0, slash));
  const key = decoded(path.slice(slash + 1));
  if (bucket === undefined || key === undefined) return undefined;
  return { bucket, key };
}

/**
 * decoded undoes the %XX escaping of one part of an https URL. Undefined
 * where the escaping is malformed, such as an unescaped `100%.csv`, so
 * handles() returns a boolean for every path.
 */
function decoded(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/** s3Url writes a location in the s3:// form, which is what a .uno records. */
export function s3Url(loc: S3Location): string {
  return `s3://${loc.bucket}/${loc.key}`;
}

/** How many times a request that failed on the network or with a 5xx is tried. */
const TRIES = 3;
/** The wait before the second try. It doubles for the third. */
const BACKOFF_MS = 200;
/** How many times one request follows a bucket to another region. */
const MOVES = 1;
/** How much of an error reply is read when looking for the region in it. */
const REFUSAL_BYTES = 64 << 10;

/**
 * s3Provider is a bucket plugged in as one thing: s3Files and s3Lister. Every
 * S3-compatible store (R2, MinIO, Supabase) is this provider with a different
 * endpoint and region.
 */
export function s3Provider(opts: S3Options): Provider {
  return { name: "s3", label: "S3", files: s3Files(opts), browse: s3Lister(opts) };
}

/**
 * S3Requests sends signed requests, retries them, and follows a bucket to its
 * region. Both the handler and the lister send through it.
 */
export interface S3Requests {
  /** One object, or one version of it: HEAD for its size, GET for a range. */
  object(
    loc: S3Location,
    method: "HEAD" | "GET",
    extra: Record<string, string>,
    version?: string,
  ): Promise<Response>;
  /** The bucket root with a query, which is what a listing asks for. */
  bucket(bucket: string, query: Record<string, string>): Promise<Response>;
  /** Who a request to `loc` goes out as, in words, for a refusal to name. */
  who(loc: S3Location): Promise<string>;
  /** Where a bucket is: one HEAD of it, followed once if it says it is
   * elsewhere. */
  where(bucket: string): Promise<string>;
}

/**
 * s3Requests makes an S3Requests over `opts`, with its own memory of which
 * region each bucket is in. s3Files and s3Lister each make their own.
 */
export function s3Requests(opts: S3Options): S3Requests {
  const go = opts.fetch ?? fetch;
  /** The region each bucket was found in, once it has said. */
  const regions = new Map<string, string>();

  /** One signed request, sent once, to the URL `at` gives for `region`. */
  async function send(
    at: (region: string) => URL,
    method: "HEAD" | "GET",
    extra: Record<string, string>,
    creds: Signing,
    region: string,
  ): Promise<Response> {
    const url = at(region);
    if ("unsigned" in creds) return go(url, { method, headers: extra });
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
   * request is `send` with retries for network and 5xx failures, and one move
   * to the region the bucket says it is in. `at` takes the region, since the
   * retry after a move goes to a different host and needs a new signature.
   */
  async function request(
    loc: S3Location,
    at: (region: string) => URL,
    method: "HEAD" | "GET",
    extra: Record<string, string>,
  ): Promise<Response> {
    const bucket = loc.bucket;
    let moves = 0;
    for (let attempt = 1; ; attempt++) {
      const creds = await opts.credentials(loc);
      const region = regions.get(bucket) ?? creds.region;

      let res: Response;
      try {
        res = await send(at, method, extra, creds, region);
      } catch (err) {
        if (attempt >= TRIES) throw err;
        await wait(BACKOFF_MS << (attempt - 1));
        continue;
      }

      // A 301 or 400 may say the bucket is in another region. It is followed
      // once, and the region is remembered.
      if ((res.status === 301 || res.status === 400) && moves < MOVES) {
        const moved = await whereItWent(res, () =>
          // A HEAD reply is headers only. When the region is only in the
          // body, a one-byte GET is sent to get it.
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

  const requests: S3Requests = {
    object: (loc, method, extra, version) =>
      request(loc, (region) => objectUrl(loc, region, opts.endpoint, version), method, extra),
    // A listing is a GET, so its error reply carries a body. It is signed as
    // the prefix it asks about, which is what a connection covers.
    bucket: (bucket, query) =>
      request(
        { bucket, key: query["prefix"] ?? "" },
        (region) => listUrl(bucket, query, region, opts.endpoint),
        "GET",
        {},
      ),
    who: async (loc) => (await opts.credentials(loc)).as ?? FOUND,
    // HeadBucket returns x-amz-bucket-region on every answer, ok or refused.
    // `request` has already followed a moved bucket by then.
    async where(bucket) {
      const loc = { bucket, key: "" };
      const res = await request(
        loc,
        (region) => new URL(`${bucketUrl(bucket, region, opts.endpoint)}/`),
        "HEAD",
        {},
      );
      const said = res.headers.get("x-amz-bucket-region");
      if (said !== null && isRegion(said)) return said;
      if (res.ok) return regions.get(bucket) ?? (await opts.credentials(loc)).region;
      const why = answered(
        res.status,
        {
          404: "no such bucket",
          403: `access denied · ${await requests.who(loc)} cannot reach that bucket`,
        },
        `S3 answered ${res.status} when asked where the bucket is`,
      );
      throw new Error(`s3://${bucket}: ${why}`);
    },
  };
  return requests;
}

/**
 * locate returns the connection with its bucket's region filled in, from one
 * HeadBucket signed the way the connection signs in. Done once, when a
 * connection is made.
 */
export async function locate(c: Connection, opts: S3Options): Promise<Connection> {
  return { ...c, region: await s3Requests(opts).where(c.bucket) };
}

/** What trying a connection before it is saved found. */
export interface Tried {
  /** The connection with its bucket's region in it, ready to save. */
  connection: Connection;
  /** How many of each the first page of its prefix held. */
  folders: number;
  files: number;
  /** Whether the prefix had more than that first page. */
  more: boolean;
}

/** What tryConnection needs: how a connection signs in, and where S3 is. */
export interface TryOptions extends Omit<S3Options, "credentials"> {
  /** How a request through `c` is signed. */
  sign: (c: Connection) => Promise<Signing>;
}

/**
 * tryConnection tests a connection before it is saved: it locates the bucket
 * and lists the first page of its prefix, both signed the way the connection
 * signs in. Any failure is thrown as it is.
 */
export async function tryConnection(c: Connection, opts: TryOptions): Promise<Tried> {
  const { sign, ...rest } = opts;
  const located = await locate(c, { ...rest, credentials: () => sign(c) });
  const where = s3Url({ bucket: located.bucket, key: located.prefix });
  const page = await s3Lister({ ...rest, credentials: () => sign(located) }).list(where);
  const folders = page.entries.filter((e) => e.folder).length;
  return {
    connection: located,
    folders,
    files: page.entries.length - folders,
    more: page.next !== undefined,
  };
}

/** A bucket an address is in, outside every connection, and the folder of
 * it. */
export interface Unconnected {
  bucket: string;
  /**
   * The folder the object is in, with its slash, or "" at the bucket root.
   * It is the narrowest prefix a new connection could cover.
   */
  prefix: string;
}

/**
 * Meeting is how an address a .uno names meets this machine's connections: the
 * id of the one it is read through, or the bucket outside every connection.
 */
export type Meeting = { through: string } | { unconnected: Unconnected };

/**
 * connectionMeeting says which connection an address is read through, or
 * which bucket is outside every connection. Undefined for an address outside
 * S3.
 *
 * It reads addresses with s3Location, the same as s3Files, and picks the
 * covering connection with the longest prefix, the same as the handler
 * signs with.
 */
export function connectionMeeting(
  connections: () => readonly Connection[],
): (path: string) => Meeting | undefined {
  return (path) => {
    const loc = s3Location(path);
    if (loc === undefined) return undefined;
    const c = covering(connections(), loc.bucket, loc.key);
    if (c !== undefined) return { through: c.id };
    return {
      unconnected: { bucket: loc.bucket, prefix: loc.key.slice(0, loc.key.lastIndexOf("/") + 1) },
    };
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
      const loc = objectAt("path" in ref ? ref.path : undefined, ref.name);
      const url = s3Url(loc);

      // A VersionId a save recorded is asked for by name. A bucket that has
      // dropped that version answers 404 or 400, and the object is then read
      // as it is now.
      let pinned = "path" in ref ? versionIdIn(ref.version) : undefined;
      let head = await send.object(loc, "HEAD", {}, pinned);
      if (pinned !== undefined && (head.status === 404 || head.status === 400)) {
        pinned = undefined;
        head = await send.object(loc, "HEAD", {});
      }
      if (!head.ok) throw await refused(send, loc, head);
      const size = sizeOf(head, url);
      // Every range is asked for with If-Match on this ETag, so an object
      // rewritten mid-read answers 412 and the bytes stay from one version.
      const etag = head.headers.get("etag");

      /** One range, asked for as the version opened. */
      const range = async (offset: number, length: number): Promise<Uint8Array> => {
        const end = Math.min(offset + length, size);
        if (end <= offset) return new Uint8Array();
        const res = await send.object(
          loc,
          "GET",
          {
            range: `bytes=${offset}-${end - 1}`,
            ...(etag === null ? {} : { "if-match": etag }),
          },
          pinned,
        );
        if (res.status === 412) {
          throw new Error(`${url} changed in the bucket since it was opened · open it again`);
        }
        if (!res.ok) throw await refused(send, loc, res);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // A server that ignored the range sent the whole object.
        return res.status === 200 && bytes.length === size ? bytes.subarray(offset, end) : bytes;
      };

      return {
        size,
        version: versionOf(head.headers),
        // Sequential reads request the next few ranges ahead.
        read: readAhead(range, size, opts.ahead),
        close: () => Promise.resolve(),
      };
    },
  };
}

/**
 * versionOf is the version a reply is about: the VersionId where the bucket
 * keeps versions, the ETag with its quotes otherwise. A bucket with
 * versioning suspended answers "null" for the VersionId, which is skipped.
 */
export function versionOf(headers: Headers): string | undefined {
  const id = headers.get("x-amz-version-id");
  if (id !== null && id !== "" && id !== "null") return id;
  return headers.get("etag") ?? undefined;
}

/**
 * versionIdIn is a recorded version that can be asked for by name: a
 * VersionId. An ETag, quoted or weak `W/`, gives undefined.
 */
function versionIdIn(version: string | undefined): string | undefined {
  if (version === undefined || version === "" || version.startsWith('"')) return undefined;
  return version.startsWith("W/") ? undefined : version;
}

/**
 * whereItWent reads an error reply for the region the bucket is in. AWS says
 * it in `x-amz-bucket-region`. Other stores and older redirects say it only
 * in the XML body, so for a headers-only reply, `probe` is sent to get a
 * body. Undefined when both leave the region unsaid.
 *
 * A region from a body becomes part of a hostname, so only a word that
 * passes isRegion is accepted.
 */
async function whereItWent(
  res: Response,
  probe: () => Promise<Response>,
): Promise<string | undefined> {
  const header = res.headers.get("x-amz-bucket-region");
  if (header !== null) return isRegion(header) ? header : undefined;

  let body = await refusalBody(res);
  if (body === "") {
    // An empty body, which is every HEAD. Send the probe to get one. A probe
    // that succeeds means the bucket is already here.
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

/** Up to REFUSAL_BYTES of an error reply, as text. */
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
    // A body cut short reads as what came before the cut.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(concat(parts));
}

/**
 * regionIn finds the region in an error body: the Region element, the
 * "expecting '...'" sentence, or the Endpoint element's host. The first one
 * present is the answer, even when it fails isRegion.
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
 * regionInHost reads the region out of an endpoint host:
 * bucket.s3.eu-west-1.amazonaws.com, or the older s3-eu-west-1.amazonaws.com.
 * The bare s3.amazonaws.com gives undefined.
 */
function regionInHost(host: string): string | undefined {
  const region = /(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i.exec(host.trim())?.[1];
  return region !== undefined && isRegion(region) ? region : undefined;
}

/**
 * isRegion says whether a word is shaped like a region: letters, digits and
 * inner hyphens, up to 32 characters. The word is spliced into a hostname,
 * and this is the only check on a region read from a body. `auto`, which R2
 * uses, passes.
 */
function isRegion(word: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(word);
}

/**
 * refusal is what a status code means when opening or statting an object.
 * `who` is whose credentials were turned away.
 */
export function refusal(status: number, who = FOUND): string {
  return answered(status, {
    403: `access denied · ${who} cannot read it`,
    404: "no such object in that bucket",
  });
}

/**
 * answered is what a status code means where it was met: the sentence `words`
 * has for it, or `otherwise`, which says the bare number.
 */
export function answered(
  status: number,
  words: Partial<Record<number, string>>,
  otherwise = `S3 answered ${status}`,
): string {
  return words[status] ?? otherwise;
}

/**
 * objectAt is the object a path names. It throws for a path outside S3, or
 * a key with a dot segment, before any request is sent. `name` is what the
 * error calls the path.
 */
export function objectAt(path: string | undefined, name: string): S3Location {
  const loc = path === undefined ? undefined : s3Location(path);
  if (loc === undefined) throw new Error(`${name}: not an object in S3`);
  const cannot = unaddressable(loc);
  if (cannot !== undefined) throw cannot;
  return loc;
}

/** The size a HEAD says, or the refusal for one that left it out. */
export function sizeOf(head: Response, url: string): number {
  const size = Number(head.headers.get("content-length") ?? "NaN");
  if (!Number.isFinite(size)) throw new Error(`${url}: S3 did not say how big it is`);
  return size;
}

/** The Error for a refused reply, naming the object and whose credentials
 * were turned away. */
export async function refused(send: S3Requests, loc: S3Location, res: Response): Promise<Error> {
  return new Error(`${s3Url(loc)}: ${refusal(res.status, await send.who(loc))}`);
}

/**
 * unaddressable is the Error for a key with a `.` or `..` segment, and
 * undefined for any other key.
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
 * dotSegment returns the `.` or `..` segment a key carries, when it carries
 * one. The WHATWG URL parser resolves such segments, `%2e` included, so a URL
 * for that key names a different object, which S3 serves with a 200. fetch
 * sends only the resolved path, so the key is refused.
 */
function dotSegment(key: string): string | undefined {
  return key.split("/").find((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

/**
 * bucketUrl is where a bucket is reached. With an endpoint it is path-style.
 * A dotted bucket name is path-style too, since the wildcard certificate on
 * the virtual-hosted name covers one label only.
 */
function bucketUrl(bucket: string, region: string, endpoint: string | undefined): string {
  if (endpoint !== undefined && endpoint !== "") {
    return `${endpoint.replace(/\/+$/, "")}/${encodePath(bucket)}`;
  }
  if (bucket.includes(".")) return `https://s3.${region}.amazonaws.com/${bucket}`;
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

/** The object's address, asking for one version where `version` is a
 * VersionId. */
function objectUrl(
  loc: S3Location,
  region: string,
  endpoint: string | undefined,
  version?: string,
): URL {
  const at = `${bucketUrl(loc.bucket, region, endpoint)}/${encodePath(loc.key)}`;
  return new URL(version === undefined ? at : `${at}?versionId=${encode(version)}`);
}

/**
 * listUrl is the bucket root with the ListObjectsV2 query on it. The query is
 * written with `encode`, since URLSearchParams writes a space as `+` and
 * SigV4 signs it as `%20`.
 */
function listUrl(
  bucket: string,
  query: Record<string, string>,
  region: string,
  endpoint: string | undefined,
): URL {
  return new URL(`${bucketUrl(bucket, region, endpoint)}/?${encodeQuery(Object.entries(query))}`);
}

/** encodeQuery writes pairs as the query of a URL, each encoded as SigV4
 * signs it. */
export function encodeQuery(pairs: Iterable<readonly [string, string]>): string {
  return Array.from(pairs, ([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
}

// ------------------------------------------------------------------ SigV4

/** The SHA-256 of an empty body, which every request here has. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Unsigned {
  method: string;
  url: URL;
  /** Everything to sign besides host and the date, which are added here. */
  headers: Record<string, string>;
}

/**
 * signV4 returns the headers that authorise a request: the ones given, plus
 * x-amz-date, the session token where there is one, and Authorization. host
 * is signed but left out of the result, since fetch sets it itself. The body
 * is always empty. The steps follow
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
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
  // fetch sets Host itself.
  delete headers["host"];
  return headers;
}

function mac(key: Uint8Array, text: string): Uint8Array {
  return hmac(sha256, key, utf8ToBytes(text));
}

function hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/**
 * canonicalQuery is the query as SigV4 signs it: each name and value encoded,
 * sorted by name and then by value. Names and values are sorted as separate
 * fields, since sorting `name=value` strings would put `prefix-x=1` ahead of
 * `prefix=J`, and S3 puts `prefix=J` first.
 */
function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([k1, v1], [k2, v2]) => compareStrings(k1, k2) || compareStrings(v1, v2))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** encodePath encodes each segment of a key as SigV4 wants it, keeping the
 * slashes. */
function encodePath(key: string): string {
  return key.split("/").map(encode).join("/");
}

/** RFC 3986 unreserved characters stay. Everything else is %XX, which is
 * stricter than encodeURIComponent about !'()*. It is what SigV4 signs with,
 * so every query a signed request carries is written with it, here and in
 * store/sts.ts. */
export function encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
