// A connection: one .unof that says where a bucket is and how to sign in to
// it.
//
// It is shaped like a formula file: one small JSON object, unrecognised keys
// carried through to the next save, unknown kinds refused by name.
//
// It names how to sign in (a profile, a role) and leaves the keys to the
// platform. Anything shaped like a key is refused on the way in and on the
// way out.
//
// It works on text alone.

import { rfc3339 } from "../go/index.ts";
import { validID } from "./index.ts";
import { about, extraOf, readUnof, stamp, textOf, timeOf, writeExtra, wrongKind } from "./unof.ts";

/** The kind a connection's file says it is. */
export const CONNECTION_KIND = "connection";

/** The kinds of place a connection can name: S3 and stores with its API. */
export type ConnectionProvider = "s3";

const PROVIDERS: readonly ConnectionProvider[] = ["s3"];

/**
 * Auth is how a connection signs in.
 *
 * - `machine`: the AWS default chain (the environment, then the default
 *   profile). The desktop and `npx uno` only.
 * - `profile`: one named profile in ~/.aws. The desktop and `npx uno` only.
 * - `role`: a role in the customer's account that trusts uno's, assumed with
 *   the requesting account's external ID. The hosted engine only. The
 *   file holds the role ARN alone.
 * - `public`: an open bucket, read unsigned.
 */
export type Auth = (
  | { mode: "machine" }
  | { mode: "profile"; profile: string }
  | { mode: "role"; roleArn: string }
  | { mode: "public" }
) & {
  /** The keys beyond this build's own, carried to the next save. */
  extra?: Map<string, unknown>;
};

export type AuthMode = Auth["mode"];

const MODES: readonly AuthMode[] = ["machine", "profile", "role", "public"];

/**
 * Connection is one .unof of kind "connection". `prefix` is where browsing
 * starts and what the connection covers. It is empty for the whole bucket,
 * and otherwise ends in a slash.
 */
export interface Connection {
  format: number;
  id: string;
  name: string;
  provider: ConnectionProvider;
  bucket: string;
  prefix: string;
  /** The bucket's region, once looked up. Absent until then. */
  region?: string;
  auth: Auth;
  created: Date | undefined;
  modified: Date | undefined;
  /** The keys beyond this build's own, carried to the next save. */
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
 * Key names that hold a secret, matched with case and separators removed:
 * `Secret-Access-Key` matches the same as `secretAccessKey`.
 */
const SECRET_NAME = /secret|password|passwd|token|credential|privatekey|accesskey/;

/**
 * The shape of an AWS access key id (AKIA, ASIA, ABIA or ACCA plus 16
 * characters), matched inside any string value.
 */
const ACCESS_KEY_ID = /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/;

/**
 * An S3 bucket name: 3 to 63 lower-case letters, digits, dots and hyphens,
 * starting and ending with a letter or a digit. Checked because the bucket
 * becomes part of a hostname.
 */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** A region's shape. Checked because it is spliced into a hostname. */
const REGION = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * A role ARN as IAM writes one: a partition, a 12-digit account, and a name
 * with an optional path before it.
 */
const ROLE_ARN = /^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

/**
 * secretIn describes the first thing in `value` that looks like a secret, or
 * returns undefined. It walks nested objects, arrays and Maps.
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
 * parseConnection reads one connection .unof from its text. `name` is only
 * used in error messages.
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

  // Checked before anything else is read, so a file holding a key is refused
  // whole.
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

/** parseAuth reads the auth block. Refuses a missing block or an unknown mode. */
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

/** What each mode reads out of its auth block, besides the mode. */
const AUTH_READERS: {
  [M in AuthMode]: (o: Record<string, unknown>, name: string) => Extract<Auth, { mode: M }>;
} = {
  machine: () => ({ mode: "machine" }),
  public: () => ({ mode: "public" }),
  profile: (o, name) => ({ mode: "profile", profile: named(o, name, "profile", "profile") }),
  role: (o, name) => ({ mode: "role", roleArn: named(o, name, "role", "roleArn") }),
};

/** named reads the one required string field of a mode, or throws. */
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
 * validConnection checks the id, bucket, prefix, region and role ARN. It runs
 * on parse and on format.
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
 * stampConnection sets modified to now and created the first time only. It
 * is separate from `formatConnection` so formatting is a pure function of
 * the connection.
 */
export function stampConnection(c: Connection, now?: Date): Connection {
  return stamp(c, now);
}

/**
 * formatConnection renders a connection as .unof text. Known keys come in
 * declared order and unrecognised ones after them in name order, inside
 * `auth` as well as at the top level. Throws if the output holds anything
 * that looks like a secret.
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

  // Checked on the output, so a key carried in `extra` is caught too.
  const secret = secretIn(out);
  if (secret !== undefined) {
    throw new Error(
      `${c.id}: ${secret} · uno does not save a connection holding a key, so it can be sent to anyone`,
    );
  }
  return JSON.stringify(out, undefined, 2) + "\n";
}

/**
 * covers reports whether `key` in `bucket` is read through `c`: same bucket,
 * and the key starts with c's prefix.
 */
export function covers(c: Connection, bucket: string, key: string): boolean {
  return c.bucket === bucket && key.startsWith(c.prefix);
}

/**
 * covering returns the connection with the longest prefix among those that
 * cover the address, or undefined.
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
