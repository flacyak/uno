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
 * Trades an SSO access token for a role's temporary keys through the SSO
 * portal's GetRoleCredentials. A 401 or 403 means the sign-in has expired or
 * been revoked, and the failure says to sign in again.
 */
export function ssoExchange(
  ask: SsoAsk,
  opts: ExchangeOptions = {},
): Effect.Effect<Session, SsoFailure> {
  return Effect.gen(function* () {
    const go = opts.fetch ?? fetch;
    const base = (
      opts.endpoint ?? `https://portal.sso.${ask.region}.amazonaws.com`
    ).replace(/\/+$/, '');
    const url = new URL(`${base}/federation/credentials`);
    url.searchParams.set('account_id', ask.accountId);
    url.searchParams.set('role_name', ask.roleName);

    const res = yield* Effect.promise(() =>
      go(url, { headers: { 'x-amz-sso_bearer_token': ask.accessToken } }),
    );
    if (res.status === 401 || res.status === 403) {
      return yield* new NotSignedIn({
        profile: ask.profile,
        why: 'the SSO portal turned its sign-in away',
      });
    }
    if (!res.ok) {
      return yield* new SsoPortalRefused({
        profile: ask.profile,
        status: res.status,
      });
    }
    return yield* ssoSessionIn(res, ask.profile);
  });
}

/** Runs ssoExchange as a Promise, for a caller outside the store. */
export function ssoRoleCredentials(
  ask: SsoAsk,
  opts: ExchangeOptions = {},
): Promise<Session> {
  return Effect.runPromise(ssoExchange(ask, opts));
}

/**
 * Reads the portal's answer to GetRoleCredentials: the session it holds, or
 * the refusal where it holds none uno can read.
 * @param res The portal's answer, with a success status.
 * @param profile The profile, for the error.
 */
function ssoSessionIn(
  res: Response,
  profile: string,
): Effect.Effect<Session, SsoUnreadable> {
  return Effect.gen(function* () {
    const body = (yield* Effect.promise(() => res.json())) as {
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
      return yield* new SsoUnreadable({ profile });
    }
    return {
      accessKeyId: id,
      secretAccessKey: secret,
      sessionToken: token,
      expiration: new Date(expiration),
    };
  });
}

/**
 * An SSO sign-in that has lapsed or was never made. The sentence says what is
 * wrong with it and gives the command that signs in again. Raised here when
 * the portal turns the sign-in away, and by store/node.ts for a cached
 * sign-in that is missing, unreadable or expired.
 */
export class NotSignedIn extends Data.TaggedError('NotSignedIn')<{
  profile: string;
  /** What is wrong with the sign-in. */
  why: string;
  message: string;
}> {
  /** @param parts The profile and what is wrong with its sign-in. */
  constructor(parts: { profile: string; why: string }) {
    super({ ...parts, message: signInAgain(parts.profile, parts.why) });
  }
}

/**
 * Builds NotSignedIn's sentence: what is wrong with the sign-in, and the
 * command that fixes it.
 * @param why What is wrong with the sign-in.
 * @return The sentence, with the command that signs in again.
 */
function signInAgain(profile: string, why: string): string {
  return `the AWS profile ${profile} is not signed in · ${why} · sign in with \`aws sso login --profile ${profile}\``;
}

/** The SSO portal answered with a status other than success. */
export class SsoPortalRefused extends Data.TaggedError('SsoPortalRefused')<{
  profile: string;
  status: number;
  message: string;
}> {
  /** @param parts The profile and the status the portal answered. */
  constructor(parts: { profile: string; status: number }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile}: the SSO portal answered ${parts.status}`,
    });
  }
}

/** The SSO portal let the role be read and answered with no credentials. */
export class SsoUnreadable extends Data.TaggedError('SsoUnreadable')<{
  profile: string;
  message: string;
}> {
  /** @param parts The profile. */
  constructor(parts: { profile: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile}: the SSO portal's answer held no credentials`,
    });
  }
}

/** What trading an SSO sign-in for a role's keys can fail with. */
export type SsoFailure = NotSignedIn | SsoPortalRefused | SsoUnreadable;

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
 * Calls STS AssumeRole as one signed GET, with `source` as the caller's
 * credentials, and succeeds with the role's session.
 *
 * It fails with a session name STS would not take, or with what STS said:
 * its error code and message. A request STS never answers rejects with the
 * runtime's own error, as a defect.
 * @param source The caller's keys, which sign the request.
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

/** Runs roleExchange as a Promise, for a caller outside the store. */
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
 * Calls STS AssumeRoleWithWebIdentity and succeeds with the role's session.
 * The call is unsigned: the token says who is asking. It goes as a POST,
 * since a token can run past what a URL holds. It fails as roleExchange does.
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

/** Runs webIdentityExchange as a Promise, for a caller outside the store. */
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
  /** @param parts The role and the session name refused. */
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
 * Refuses a name STS would not take, before any request is sent.
 * @param roleArn The role, for the error.
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
  /** STS's error code, or `HTTP <status>` where its answer named none. */
  code: string;
  /** STS's message, where it gave one. */
  detail?: string;
  message: string;
}> {
  /** @param parts The role, STS's error code, and its message if any. */
  constructor(parts: { roleArn: string; code: string; detail?: string }) {
    super({
      ...parts,
      message: `STS would not let ${parts.roleArn} be assumed · ${parts.code}${parts.detail === undefined ? '' : `: ${parts.detail}`}`,
    });
  }
}

/**
 * STS let the role be assumed and answered with no credentials uno could
 * read.
 */
export class StsUnreadable extends Data.TaggedError('StsUnreadable')<{
  roleArn: string;
  message: string;
}> {
  /** @param parts The role. */
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
 * Reads STS's answer to a role assumption: the session it holds, or the
 * refusal with STS's error code and message.
 * @param roleArn The role, for the error.
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
