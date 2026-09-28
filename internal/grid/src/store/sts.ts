// Trading one credential for another, over the network.
//
// Some ways of signing in never put keys on the disk. An SSO profile holds a
// token from the last `aws sso login`, and a role holds only its ARN. Each is
// turned into short-lived keys by asking AWS, and those asks live here: the
// SSO portal's GetRoleCredentials now, and STS's AssumeRole beside it.
//
// This is the one module besides store/s3.ts allowed to reach a network, and
// the guard test in tests/store/opens.test.ts holds it to that. Nothing here
// reads a file: which token and which role are store/node.ts's business, which
// reads ~/.aws, and hands the answer here to be exchanged.

import { encode, signV4 } from "./s3.ts";
import type { AwsCredentials } from "./s3.ts";

/** Keys AWS handed out for a while, and when they stop working. */
export interface Session {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

/** How an exchange reaches AWS: where, and through what. */
export interface ExchangeOptions {
  /**
   * An endpoint to use instead of AWS's, for a stand-in in a test or a
   * gateway in front of the real one. It is what AWS_ENDPOINT_URL_SSO and
   * AWS_ENDPOINT_URL_STS name for every other AWS tool.
   */
  endpoint?: string;
  /** How requests go out. Defaults to the runtime's own fetch. */
  fetch?: typeof fetch;
}

/** What an SSO profile names, once its token has been read off the disk. */
export interface SsoAsk {
  /** The profile, for the sentence a refusal is. */
  profile: string;
  /** Where the SSO portal is: the sso_region, not the region the profile reads buckets in. */
  region: string;
  accountId: string;
  roleName: string;
  /** The access token `aws sso login` left in ~/.aws/sso/cache. */
  accessToken: string;
}

/**
 * ssoRoleCredentials trades an SSO access token for a role's keys, which is
 * what the AWS CLI does under every command run with an SSO profile.
 *
 * A refused token is an expired or revoked sign-in, and the only thing that
 * mends one is the person signing in again, so that is what the refusal says.
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
 * signInAgain is the sentence for an SSO sign-in that no longer works, with
 * the command that mends it. It is shared with store/node.ts, which says it
 * first when the cached token has already expired on disk.
 */
export function signInAgain(profile: string, why: string): string {
  return `the AWS profile ${profile} is not signed in · ${why} · sign in with \`aws sso login --profile ${profile}\``;
}

/** What AssumeRole is asked for: which role, as whom, and for how long. */
export interface RoleAsk {
  roleArn: string;
  /** What the session is called in the role owner's CloudTrail. */
  sessionName: string;
  /** The condition the role's trust policy checks, when it has one. */
  externalId?: string;
  /** How long the session lasts. The role's own maximum still applies. */
  durationSeconds?: number;
  /** Which STS to ask, and so which region the call is signed for. */
  region: string;
}

/** The STS API version AssumeRole is asked in. */
const STS_VERSION = "2011-06-15";

/**
 * assumeRole takes on a role with the credentials that are allowed to, and
 * hands back the role's session.
 *
 * It is one signed GET to STS, the same SigV4 every S3 request is, for the
 * service "sts": what trusts the caller is the role's trust policy, and what
 * it checks -- the caller's account, and an external ID where the policy asks
 * for one -- is all in that one request. The desktop reaches it through a
 * profile with role_arn and source_profile; the hosted engine will reach it
 * with the requesting account's external ID.
 *
 * A refusal says what STS said, code and all: AccessDenied is almost always a
 * trust policy that does not name the caller, or an external ID that is not
 * the one it asks for, and the person fixing it needs to know which.
 */
export async function assumeRole(
  ask: RoleAsk,
  source: Omit<AwsCredentials, "region">,
  opts: ExchangeOptions = {},
): Promise<Session> {
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
  // Written with the encoder SigV4 signs with, for the reason listUrl in
  // store/s3.ts gives: a form-encoded space is a `+` on the wire and `%20` in
  // the signature, and the two would not agree.
  const url = new URL(`${base}/?${query.map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&")}`);

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
    const code = element(body, "Code") ?? `HTTP ${res.status}`;
    const message = element(body, "Message");
    throw new Error(
      `STS would not let ${ask.roleArn} be assumed · ${code}${message === undefined ? "" : `: ${message}`}`,
    );
  }

  const credentials = element(body, "Credentials");
  const id = credentials === undefined ? undefined : element(credentials, "AccessKeyId");
  const secret = credentials === undefined ? undefined : element(credentials, "SecretAccessKey");
  const token = credentials === undefined ? undefined : element(credentials, "SessionToken");
  const expires = credentials === undefined ? undefined : element(credentials, "Expiration");
  const expiration = new Date(expires ?? "");
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

/**
 * element is the text of the first <name> in some XML, entities undone, or
 * undefined where there is none. STS's answer is four elements deep and uno
 * reads six names out of it, so this is the whole of the XML it needs: the
 * store/s3xml.ts reader is ListBucketResult's, and its rules are that reply's.
 */
function element(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  if (m === null) return undefined;
  return m[1]!.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
    const lower = e.toLowerCase();
    if (lower in named) return named[lower]!;
    return String.fromCodePoint(
      lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10),
    );
  });
}
