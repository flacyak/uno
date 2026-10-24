/**
 * @fileoverview Exchanging one credential for another over the network: the SSO
 * portal's GetRoleCredentials, and STS's AssumeRole and
 * AssumeRoleWithWebIdentity.
 *
 * This module, store/s3.ts and store/metadata.ts are the only ones allowed
 * to reach a network. The guard test in tests/store/opens.test.ts checks
 * that. Every file read is in store/node.ts, which reads ~/.aws and passes
 * the token or role in.
 *
 * An exchange is an Effect that fails with what the service said. The
 * function named for the call runs it as a Promise, at the store's edge.
 */

import { Data, Effect } from 'effect';

import { parseTime } from '@go';
import { encodeQuery, signV4 } from './s3.ts';
import type { AwsCredentials } from './s3.ts';
import { text } from './s3xml.ts';

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
 * @param ask the profile's portal, account and role, with its access token
 * @param opts where the exchange is sent and how requests go out
 * @return the role's temporary keys
 */
export async function ssoRoleCredentials(
  ask: SsoAsk,
  opts: ExchangeOptions = {},
): Promise<Session> {
  const go = opts.fetch ?? fetch;
  const base = (
    opts.endpoint ?? `https://portal.sso.${ask.region}.amazonaws.com`
  ).replace(/\/+$/, '');
  const url = new URL(`${base}/federation/credentials`);
  url.searchParams.set('account_id', ask.accountId);
  url.searchParams.set('role_name', ask.roleName);

  const res = await go(url, {
    headers: { 'x-amz-sso_bearer_token': ask.accessToken },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      signInAgain(ask.profile, 'the SSO portal turned its sign-in away'),
    );
  }
  if (!res.ok) {
    throw new Error(
      `the AWS profile ${ask.profile}: the SSO portal answered ${res.status}`,
    );
  }
  const body = (await res.json()) as {
    roleCredentials?: Record<string, unknown>;
  };
  const r = body.roleCredentials;
  const id = r?.['accessKeyId'];
  const secret = r?.['secretAccessKey'];
  const token = r?.['sessionToken'];
  const expiration = r?.['expiration'];
  if (
    typeof id !== 'string' ||
    typeof secret !== 'string' ||
    typeof token !== 'string' ||
    typeof expiration !== 'number'
  ) {
    throw new Error(
      `the AWS profile ${ask.profile}: the SSO portal's answer held no credentials`,
    );
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
 * @param profile the profile's name
 * @param why what is wrong with the sign-in
 * @return the message, with the command that signs in again
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
const STS_VERSION = '2011-06-15';

/**
 * What STS accepts as a RoleSessionName: 2 to 64 of these characters. Checked
 * here so a bad role_session_name is refused before the request goes out.
 */
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;

/**
 * roleExchange calls STS AssumeRole as one signed GET, with `source` as the
 * caller's credentials, and succeeds with the role's session.
 *
 * It fails with a session name STS would not take, or with what STS said:
 * its error code and message. A request STS never answers rejects with the
 * runtime's own error, as a defect.
 * @param ask the role, the session and the region
 * @param source the caller's keys, which sign the request
 * @param opts where the exchange is sent and how requests go out
 * @return the role's session
 */
export function roleExchange(
  ask: RoleAsk,
  source: Omit<AwsCredentials, 'region'>,
  opts: ExchangeOptions = {},
): Effect.Effect<Session, StsFailure> {
  return Effect.gen(function* () {
    yield* checkSessionName(ask.roleArn, ask.sessionName);
    const go = opts.fetch ?? fetch;
    const query: Array<[string, string]> = [
      ['Action', 'AssumeRole'],
      ['Version', STS_VERSION],
      ['RoleArn', ask.roleArn],
      ['RoleSessionName', ask.sessionName],
    ];
    if (ask.durationSeconds !== undefined)
      query.push(['DurationSeconds', String(ask.durationSeconds)]);
    if (ask.externalId !== undefined)
      query.push(['ExternalId', ask.externalId]);
    // Encoded with the encoder SigV4 signs with, so the query on the wire
    // matches the signature. URLSearchParams would write a space as `+`.
    const url = new URL(`${stsBase(ask.region, opts)}/?${encodeQuery(query)}`);

    const headers = signV4(
      { method: 'GET', url, headers: {} },
      source,
      ask.region,
      'sts',
      new Date(),
    );
    const res = yield* Effect.promise(() =>
      go(url, { method: 'GET', headers }),
    );
    return yield* sessionIn(res, ask.roleArn);
  });
}

/**
 * assumeRole runs roleExchange as a Promise, for a caller outside the store.
 * @param ask the role, the session and the region
 * @param source the caller's keys, which sign the request
 * @param opts where the exchange is sent and how requests go out
 * @return the role's session
 */
export function assumeRole(
  ask: RoleAsk,
  source: Omit<AwsCredentials, 'region'>,
  opts: ExchangeOptions = {},
): Promise<Session> {
  return Effect.runPromise(roleExchange(ask, source, opts));
}

/** What AssumeRoleWithWebIdentity is asked for. */
export interface WebIdentityAsk {
  roleArn: string;
  /** The session name shown in the role owner's CloudTrail. */
  sessionName: string;
  /** The token the identity provider issued, which the role's trust checks. */
  token: string;
  /** How long the session lasts, up to the role's own maximum. */
  durationSeconds?: number;
  /** Which regional STS endpoint to call. */
  region: string;
}

/**
 * webIdentityExchange calls STS AssumeRoleWithWebIdentity and succeeds with
 * the role's session. The call is unsigned: the token says who is asking.
 * It goes as a POST, since a token can run past what a URL holds. It fails
 * as roleExchange does.
 * @param ask the role, the session, the token and the region
 * @param opts where the exchange is sent and how requests go out
 * @return the role's session
 */
export function webIdentityExchange(
  ask: WebIdentityAsk,
  opts: ExchangeOptions = {},
): Effect.Effect<Session, StsFailure> {
  return Effect.gen(function* () {
    yield* checkSessionName(ask.roleArn, ask.sessionName);
    const go = opts.fetch ?? fetch;
    const query: Array<[string, string]> = [
      ['Action', 'AssumeRoleWithWebIdentity'],
      ['Version', STS_VERSION],
      ['RoleArn', ask.roleArn],
      ['RoleSessionName', ask.sessionName],
      ['WebIdentityToken', ask.token],
    ];
    if (ask.durationSeconds !== undefined)
      query.push(['DurationSeconds', String(ask.durationSeconds)]);
    const res = yield* Effect.promise(() =>
      go(`${stsBase(ask.region, opts)}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: encodeQuery(query),
      }),
    );
    return yield* sessionIn(res, ask.roleArn);
  });
}

/**
 * assumeRoleWithWebIdentity runs webIdentityExchange as a Promise, for a
 * caller outside the store.
 * @param ask the role, the session, the token and the region
 * @param opts where the exchange is sent and how requests go out
 * @return the role's session
 */
export function assumeRoleWithWebIdentity(
  ask: WebIdentityAsk,
  opts: ExchangeOptions = {},
): Promise<Session> {
  return Effect.runPromise(webIdentityExchange(ask, opts));
}

/**
 *
 * Where STS is for a region: the endpoint given, or AWS's regional one.
 * @param region the region whose STS is called
 * @param opts the endpoint that replaces it, if any
 * @return the endpoint, with no trailing slash
 */
function stsBase(region: string, opts: ExchangeOptions): string {
  return (opts.endpoint ?? `https://sts.${region}.amazonaws.com`).replace(
    /\/+$/,
    '',
  );
}

/**
 * A role session name STS would not take, refused before any request is
 * sent.
 */
export class SessionNameRefused extends Data.TaggedError('SessionNameRefused')<{
  roleArn: string;
  sessionName: string;
  message: string;
}> {
  constructor(parts: { roleArn: string; sessionName: string }) {
    super({
      ...parts,
      message:
        `${parts.roleArn} cannot be assumed as ${JSON.stringify(parts.sessionName)} · ` +
        'a role session name is 2 to 64 of letters, digits and +=,.@_-',
    });
  }
}

/**
 * checkSessionName refuses a name STS would not take, before any request is
 * sent.
 * @param roleArn the role, for the error
 * @param sessionName the name to check
 * @return nothing, or the refusal
 */
function checkSessionName(
  roleArn: string,
  sessionName: string,
): Effect.Effect<void, SessionNameRefused> {
  return SESSION_NAME.test(sessionName)
    ? Effect.void
    : Effect.fail(new SessionNameRefused({ roleArn, sessionName }));
}

/**
 * STS would not let the role be assumed: its error code, and its message
 * where it gave one.
 */
export class StsRefused extends Data.TaggedError('StsRefused')<{
  roleArn: string;
  code: string;
  detail?: string;
  message: string;
}> {
  constructor(parts: { roleArn: string; code: string; detail?: string }) {
    super({
      ...parts,
      message: `STS would not let ${parts.roleArn} be assumed · ${parts.code}${parts.detail === undefined ? '' : `: ${parts.detail}`}`,
    });
  }
}

/** STS let the role be assumed and answered with no credentials uno could read. */
export class StsUnreadable extends Data.TaggedError('StsUnreadable')<{
  roleArn: string;
  message: string;
}> {
  constructor(parts: { roleArn: string }) {
    super({
      ...parts,
      message: `STS let ${parts.roleArn} be assumed and answered with no credentials uno could read`,
    });
  }
}

/** What assuming a role at STS can fail with. */
export type StsFailure = SessionNameRefused | StsRefused | StsUnreadable;

/**
 * sessionIn reads STS's answer to a role assumption: the session it holds,
 * or the refusal with STS's error code and message.
 * @param res STS's answer
 * @param roleArn the role, for the error
 * @return the session the answer holds
 */
function sessionIn(
  res: Response,
  roleArn: string,
): Effect.Effect<Session, StsRefused | StsUnreadable> {
  return Effect.gen(function* () {
    const body = yield* Effect.promise(() => res.text());
    if (!res.ok) {
      return yield* new StsRefused({
        roleArn,
        code: text(body, 'Code') ?? `HTTP ${res.status}`,
        detail: text(body, 'Message'),
      });
    }

    // A missing Credentials element reads as empty, so every field is
    // missing.
    const credentials = text(body, 'Credentials') ?? '';
    const id = text(credentials, 'AccessKeyId');
    const secret = text(credentials, 'SecretAccessKey');
    const token = text(credentials, 'SessionToken');
    const expiration = parseTime(text(credentials, 'Expiration'));
    if (
      id === undefined ||
      secret === undefined ||
      token === undefined ||
      expiration === undefined
    ) {
      return yield* new StsUnreadable({ roleArn });
    }
    return {
      accessKeyId: id,
      secretAccessKey: secret,
      sessionToken: token,
      expiration,
    };
  });
}
