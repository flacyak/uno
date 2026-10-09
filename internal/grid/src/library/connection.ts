// A connection: one .unof that says where a bucket is and how to sign in to it.
//
// It is shaped like a saved formula on purpose. A connection is shared the way
// a formula is -- by sending the file -- so it is one small JSON file, it
// carries what this build does not recognise through to the next save, and it
// refuses by name what it cannot read rather than guessing.
//
// What it never carries is a secret. People diff these files, mail them and
// commit them, so a connection names *how* to sign in -- a profile, a role --
// and never the keys that do. Anything shaped like a key is refused on the way
// in and on the way out, so a file that passes here can be sent to anybody.
//
// Nothing here touches a filesystem or a network, for the reason the formula
// codec touches neither: where the files live is `store`'s business, and
// signing in is the engine's.

import { rfc3339 } from "../go/index.ts";
import { validID } from "./index.ts";
import { about, extraOf, readUnof, stamp, textOf, timeOf, writeExtra, wrongKind } from "./unof.ts";

/** The kind a connection's file says it is, beside a formula's column and notation. */
export const CONNECTION_KIND = "connection";

/** The kinds of place a connection can name. S3 and the stores that copy its API. */
export type ConnectionProvider = "s3";

const PROVIDERS: readonly ConnectionProvider[] = ["s3"];

/**
 * Auth is how a connection signs in, and only how.
 *
 * - `machine`: the AWS chain as the CLI runs it -- the environment, then the
 *   default profile. The desktop and `npx uno` only.
 * - `profile`: one named profile in ~/.aws: keys, SSO, credential_process, or
 *   role_arn with source_profile. The desktop and `npx uno` only.
 * - `role`: a role in the customer's account that trusts uno's, taken on with
 *   the requesting account's external ID. The hosted engine only, and the
 *   external ID is never in the file: it belongs to the account asking.
 * - `public`: an open bucket, read unsigned. Everywhere.
 */
export type Auth = (
  | { mode: "machine" }
  | { mode: "profile"; profile: string }
  | { mode: "role"; roleArn: string }
  | { mode: "public" }
) & {
  /** The keys this build did not recognise, carried to the next save. */
  extra?: Map<string, unknown>;
};

export type AuthMode = Auth["mode"];

const MODES: readonly AuthMode[] = ["machine", "profile", "role", "public"];

/**
 * Connection is one .unof of kind "connection".
 *
 * `prefix` is where browsing starts and what the connection covers: an object
 * is read through the connection whose bucket it is in and whose prefix its key
 * starts with. It is empty for the whole bucket, and otherwise ends in a slash,
 * because a prefix without one is not a folder and would cover `shop-old/` as
 * well as `shop/`.
 */
export interface Connection {
  format: number;
  id: string;
  name: string;
  provider: ConnectionProvider;
  bucket: string;
  prefix: string;
  /** Where the bucket is, once somebody has asked it. Absent until then. */
  region?: string;
  auth: Auth;
  created: Date | undefined;
  modified: Date | undefined;
  /** The keys this build did not recognise, carried to the next save. */
  extra?: Map<string, unknown>;
}

/** The keys this build owns, at the top of the file and inside `auth`. */
const KNOWN_KEYS = new Set([
  "format",
  "id",
  "name",
  "kind",
  "provider",
  "bucket",
  "prefix",
  "region",
  "auth",
  "created",
  "modified",
]);
const isKnown = (key: string): boolean => KNOWN_KEYS.has(key);
const AUTH_KEYS: Record<AuthMode, readonly string[]> = {
  machine: ["mode"],
  profile: ["mode", "profile"],
  role: ["mode", "roleArn"],
  public: ["mode"],
};

/**
 * A key's name that says it holds a secret: aws_secret_access_key,
 * secretAccessKey, aws_session_token, password, a private key. Matched on the
 * name with case and separators ignored, so `Secret-Access-Key` is caught the
 * same as `secretAccessKey`.
 */
const SECRET_NAME = /secret|password|passwd|token|credential|privatekey|accesskey/;

/**
 * An AWS access key id, wherever it sits: AKIA for a user's long-lived key,
 * ASIA for a session's. Caught by its shape, so one pasted under an innocent
 * name -- `"note": "AKIA…"` -- is refused too.
 */
const ACCESS_KEY_ID = /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/;

/**
 * An S3 bucket name as AWS allows one to be made: 3 to 63 lower-case letters,
 * digits, dots and hyphens, starting and ending with a letter or a digit.
 *
 * It is checked because the bucket becomes part of a hostname, and a file
 * somebody sent is what it came out of. A name that could end the host or
 * start a path is a different server to sign a request for.
 */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** A region's shape, for the same reason: it is spliced into a hostname. */
const REGION = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * A role's ARN as IAM writes one: a partition, a 12-digit account, and a name
 * of the characters IAM allows, with a path before it where there is one. It
 * is checked because the file somebody sent is what it came out of, and the
 * ARN is what the hosted engine asks STS to let it be.
 */
const ROLE_ARN = /^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

/**
 * secretIn names the first thing in a value that looks like a secret, or
 * answers undefined when there is none. It walks the whole value, because a key
 * nested three objects down is sent along with the file just the same.
 */
export function secretIn(value: unknown, at = ""): string | undefined {
  if (typeof value === "string") {
    return ACCESS_KEY_ID.test(value)
      ? `${at === "" ? "a value" : at} holds an AWS access key id`
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const found = secretIn(v, `${at}[${i}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value instanceof Map) return secretIn(Object.fromEntries(value), at);
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, v] of Object.entries(value)) {
    const path = at === "" ? key : `${at}.${key}`;
    if (SECRET_NAME.test(key.toLowerCase().replace(/[^a-z]/g, ""))) {
      return `${path} looks like a secret`;
    }
    const found = secretIn(v, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * parseConnection reads one connection .unof.
 *
 * Like parseFormula, nothing outside the text is consulted: a connection a
 * colleague sent opens on a machine that has never had one. `name` is only
 * used to name the file in an error.
 */
export function parseConnection(name: string, text: string): Connection {
  const { o, format } = readUnof(name, text);

  const kind = o["kind"];
  if (kind !== CONNECTION_KIND) {
    throw wrongKind(name, kind, "connection", {
      kinds: ["column", "notation"],
      is: "a formula",
      dir: "formulas/",
    });
  }

  // Before anything else is read out of it, so a file carrying a key is never
  // half-loaded into something that could be saved again.
  const secret = secretIn(o);
  if (secret !== undefined) {
    throw new Error(`${name}: ${secret} · a connection names how to sign in and never holds a key`);
  }

  const provider = o["provider"];
  if (typeof provider !== "string" || !PROVIDERS.includes(provider as ConnectionProvider)) {
    throw new Error(
      provider === undefined
        ? `${name} names no provider`
        : `${name}: this build does not connect to ${JSON.stringify(provider)} · it connects to ${PROVIDERS.join(", ")}`,
    );
  }

  const c: Connection = {
    format,
    id: textOf(o, "id"),
    name: textOf(o, "name"),
    provider: provider as ConnectionProvider,
    bucket: textOf(o, "bucket"),
    prefix: textOf(o, "prefix"),
    auth: parseAuth(name, o["auth"]),
    created: timeOf(o, "created"),
    modified: timeOf(o, "modified"),
  };
  const region = textOf(o, "region");
  if (region !== "") c.region = region;
  const extra = extraOf(o, isKnown);
  if (extra !== undefined) c.extra = extra;

  about(name, () => validConnection(c));
  return c;
}

/** parseAuth reads the one block that says how to sign in, refusing a mode it does not know. */
function parseAuth(name: string, raw: unknown): Auth {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${name} does not say how to sign in: it has no auth block`);
  }
  const o = raw as Record<string, unknown>;
  const mode = o["mode"];
  if (!isMode(mode)) {
    throw new Error(
      mode === undefined
        ? `${name}: its auth block has no mode`
        : `${name}: this build does not know auth mode ${JSON.stringify(mode)} · it knows ${MODES.join(", ")}`,
    );
  }
  const auth: Auth = AUTH_READERS[mode](o, name);
  const extra = extraOf(o, authKnown(mode));
  if (extra !== undefined) auth.extra = extra;
  return auth;
}

function isMode(v: unknown): v is AuthMode {
  return typeof v === "string" && MODES.includes(v as AuthMode);
}

/** What each mode reads out of its auth block, besides the mode: a profile and a role each name one thing. */
const AUTH_READERS: {
  [M in AuthMode]: (o: Record<string, unknown>, name: string) => Extract<Auth, { mode: M }>;
} = {
  machine: () => ({ mode: "machine" }),
  public: () => ({ mode: "public" }),
  profile: (o, name) => ({ mode: "profile", profile: named(o, name, "profile", "profile") }),
  role: (o, name) => ({ mode: "role", roleArn: named(o, name, "role", "roleArn") }),
};

/** named is the one field a mode has to name, or the refusal for a block that does not. */
function named(o: Record<string, unknown>, name: string, mode: AuthMode, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") {
    throw new Error(`${name}: auth mode "${mode}" names no ${key}`);
  }
  return v;
}

/** Whether a key inside an auth block is one this build reads for that mode. */
function authKnown(mode: AuthMode): (key: string) => boolean {
  return (key) => AUTH_KEYS[mode].includes(key);
}

/**
 * validConnection checks the values that reach outside the file: the id, which
 * becomes a filename, the bucket, prefix and region, which become a host and
 * a path, and a role's ARN, which is asked of STS. It runs on the way in and
 * on the way out.
 */
export function validConnection(c: Connection): void {
  validID(c.id, "connection");
  if (!BUCKET.test(c.bucket) || c.bucket.includes("..")) {
    throw new Error(
      c.bucket === ""
        ? "names no bucket"
        : `${JSON.stringify(c.bucket)} is not a bucket name · 3 to 63 lower-case letters, digits, dots and hyphens`,
    );
  }
  if (c.prefix !== "" && (!c.prefix.endsWith("/") || c.prefix.startsWith("/"))) {
    throw new Error(
      `prefix ${JSON.stringify(c.prefix)} is not a folder · write it without a leading slash and with a trailing one, like shop/2025/`,
    );
  }
  if (c.region !== undefined && !REGION.test(c.region)) {
    throw new Error(`${JSON.stringify(c.region)} is not a region`);
  }
  if (c.auth.mode === "role" && !ROLE_ARN.test(c.auth.roleArn)) {
    throw new Error(
      `${JSON.stringify(c.auth.roleArn)} is not a role's ARN · one reads arn:aws:iam::123456789012:role/name`,
    );
  }
}

/**
 * stampConnection sets the times a save records: modified is now, and created
 * is filled in the first time only, so a connection cannot come to claim it was
 * made after it was last changed.
 *
 * It is apart from `formatConnection` so that formatting stays a function of
 * the connection alone, which is what lets a file round-trip byte for byte.
 */
export function stampConnection(c: Connection, now?: Date): Connection {
  return stamp(c, now);
}

/**
 * formatConnection renders a connection as its .unof, refusing one that holds
 * anything shaped like a secret.
 *
 * The known keys come in the order they are declared and the unrecognised ones
 * after them in name order, inside `auth` as well as around it, so a file read
 * and written again without a change is the same bytes it was.
 */
export function formatConnection(c: Connection): string {
  validConnection(c);

  const auth: Record<string, unknown> = { mode: c.auth.mode };
  if (c.auth.mode === "profile") auth["profile"] = c.auth.profile;
  if (c.auth.mode === "role") auth["roleArn"] = c.auth.roleArn;
  writeExtra(auth, c.auth.extra, authKnown(c.auth.mode));

  const out: Record<string, unknown> = {
    format: c.format,
    id: c.id,
    name: c.name,
    kind: CONNECTION_KIND,
    provider: c.provider,
    bucket: c.bucket,
    prefix: c.prefix,
  };
  if (c.region !== undefined) out["region"] = c.region;
  out["auth"] = auth;
  if (c.created !== undefined) out["created"] = rfc3339(c.created);
  if (c.modified !== undefined) out["modified"] = rfc3339(c.modified);
  writeExtra(out, c.extra, isKnown);

  // Checked on what is about to be written rather than on the connection, so
  // nothing carried through `extra` can slip a key past it.
  const secret = secretIn(out);
  if (secret !== undefined) {
    throw new Error(
      `${c.id}: ${secret} · uno does not save a connection holding a key, so it can be sent to anyone`,
    );
  }
  return JSON.stringify(out, undefined, 2) + "\n";
}

/**
 * covers says whether an object, or a prefix a listing asks about, in `bucket`
 * is read through `c`: it is in c's bucket, and its key starts with c's prefix.
 */
export function covers(c: Connection, bucket: string, key: string): boolean {
  return c.bucket === bucket && key.startsWith(c.prefix);
}

/**
 * covering is the connection an address is read through: of the connections
 * that cover it, the one with the longest prefix.
 *
 * Longest, because a narrower connection is the more deliberate one. A bucket
 * connected whole through one profile and its finance/ folder through another
 * reads finance/ with the second, which is the one somebody set up for it.
 */
export function covering(
  connections: readonly Connection[],
  bucket: string,
  key: string,
): Connection | undefined {
  let best: Connection | undefined;
  for (const c of connections) {
    if (covers(c, bucket, key) && (best === undefined || c.prefix.length > best.prefix.length)) {
      best = c;
    }
  }
  return best;
}
