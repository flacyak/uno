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
