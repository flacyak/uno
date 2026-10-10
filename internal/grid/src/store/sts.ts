// Exchanging one credential for another over the network: the SSO portal's
// GetRoleCredentials, and STS's AssumeRole.
//
// This module and store/s3.ts are the only ones allowed to reach a network.
// The guard test in tests/store/opens.test.ts checks that. Every file read
// is in store/node.ts, which reads ~/.aws and passes the token or role in.

import { encodeQuery, signV4 } from "./s3.ts";
import type { AwsCredentials } from "./s3.ts";
import { text } from "./s3xml.ts";

/** Temporary keys, and when they expire. */
export interface Session {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

/** Where an exchange is sent, and through what. */
export interface ExchangeOptions {
  /**
   * An endpoint that replaces AWS's, for a test stand-in or a gateway.
   * The same thing AWS_ENDPOINT_URL_SSO and AWS_ENDPOINT_URL_STS name.
   */
  endpoint?: string;
  /** How requests go out. Defaults to the runtime's fetch. */
  fetch?: typeof fetch;
}

/** What an SSO profile names, with its cached access token. */
export interface SsoAsk {
  /** The profile name, for error messages. */
  profile: string;
  /** The sso_region, where the SSO portal is. */
  region: string;
  accountId: string;
  roleName: string;
  /** The access token `aws sso login` left in ~/.aws/sso/cache. */
  accessToken: string;
}

/**
 * ssoRoleCredentials trades an SSO access token for a role's temporary keys
 * through the SSO portal's GetRoleCredentials. A 401 or 403 means the sign-in
 * has expired or been revoked, and the error says to sign in again.
 */
export async function ssoRoleCredentials(
  ask: SsoAsk,
  opts: ExchangeOptions = {},
): Promise<Session> {
  const go = opts.fetch ?? fetch;
  const base = (opts.endpoint ?? `https://portal.sso.${ask.region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  const url = new URL(`${base}/federation/credentials`);
  url.searchParams.set("account_id", ask.accountId);
  url.searchParams.set("role_name", ask.roleName);

  const res = await go(url, { headers: { "x-amz-sso_bearer_token": ask.accessToken } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(signInAgain(ask.profile, "the SSO portal turned its sign-in away"));
  }
  if (!res.ok) {
    throw new Error(`the AWS profile ${ask.profile}: the SSO portal answered ${res.status}`);
  }
  const body = (await res.json()) as { roleCredentials?: Record<string, unknown> };
  const r = body.roleCredentials;
  const id = r?.["accessKeyId"];
  const secret = r?.["secretAccessKey"];
  const token = r?.["sessionToken"];
  const expiration = r?.["expiration"];
  if (
    typeof id !== "string" ||
    typeof secret !== "string" ||
    typeof token !== "string" ||
    typeof expiration !== "number"
  ) {
    throw new Error(`the AWS profile ${ask.profile}: the SSO portal's answer held no credentials`);
  }
  return {
    accessKeyId: id,
    secretAccessKey: secret,
    sessionToken: token,
    expiration: new Date(expiration),
  };
}

/**
 * signInAgain is the error message for an SSO sign-in that has lapsed,
 * with the command that fixes it. Also used by store/node.ts.
 */
export function signInAgain(profile: string, why: string): string {
  return `the AWS profile ${profile} is not signed in · ${why} · sign in with \`aws sso login --profile ${profile}\``;
}

/** What AssumeRole is asked for. */
export interface RoleAsk {
  roleArn: string;
  /** The session name shown in the role owner's CloudTrail. */
  sessionName: string;
  /** The ExternalId the role's trust policy checks, when it has one. */
  externalId?: string;
  /** How long the session lasts, up to the role's own maximum. */
  durationSeconds?: number;
  /** Which regional STS endpoint to call, and the region to sign for. */
  region: string;
}

/** The STS API version AssumeRole is asked in. */
const STS_VERSION = "2011-06-15";

/**
 * What STS accepts as a RoleSessionName: 2 to 64 of these characters. Checked
 * here so a bad role_session_name is refused before the request goes out.
 */
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;

/**
 * assumeRole calls STS AssumeRole as one signed GET, with `source` as the
 * caller's credentials, and returns the role's session.
 *
 * An error includes STS's error code and message.
 */
export async function assumeRole(
  ask: RoleAsk,
  source: Omit<AwsCredentials, "region">,
  opts: ExchangeOptions = {},
): Promise<Session> {
  if (!SESSION_NAME.test(ask.sessionName)) {
    throw new Error(
      `${ask.roleArn} cannot be assumed as ${JSON.stringify(ask.sessionName)} · ` +
        "a role session name is 2 to 64 of letters, digits and +=,.@_-",
    );
  }
  const go = opts.fetch ?? fetch;
  const base = (opts.endpoint ?? `https://sts.${ask.region}.amazonaws.com`).replace(/\/+$/, "");
  const query: Array<[string, string]> = [
    ["Action", "AssumeRole"],
    ["Version", STS_VERSION],
    ["RoleArn", ask.roleArn],
    ["RoleSessionName", ask.sessionName],
  ];
  if (ask.durationSeconds !== undefined)
    query.push(["DurationSeconds", String(ask.durationSeconds)]);
  if (ask.externalId !== undefined) query.push(["ExternalId", ask.externalId]);
  // Encoded with the encoder SigV4 signs with, so the query on the wire
  // matches the signature. URLSearchParams would write a space as `+`.
  const url = new URL(`${base}/?${encodeQuery(query)}`);

  const headers = signV4(
    { method: "GET", url, headers: {} },
    source,
    ask.region,
    "sts",
    new Date(),
  );
  const res = await go(url, { method: "GET", headers });
  const body = await res.text();
  if (!res.ok) {
    const code = text(body, "Code") ?? `HTTP ${res.status}`;
    const message = text(body, "Message");
    throw new Error(
      `STS would not let ${ask.roleArn} be assumed · ${code}${message === undefined ? "" : `: ${message}`}`,
    );
  }

  // A missing Credentials element reads as empty, so every field is missing.
  const credentials = text(body, "Credentials") ?? "";
  const id = text(credentials, "AccessKeyId");
  const secret = text(credentials, "SecretAccessKey");
  const token = text(credentials, "SessionToken");
  const expiration = new Date(text(credentials, "Expiration") ?? "");
  if (
    id === undefined ||
    secret === undefined ||
    token === undefined ||
    Number.isNaN(expiration.getTime())
  ) {
    throw new Error(`STS answered ${ask.roleArn}'s AssumeRole with no credentials uno could read`);
  }
  return { accessKeyId: id, secretAccessKey: secret, sessionToken: token, expiration };
}
