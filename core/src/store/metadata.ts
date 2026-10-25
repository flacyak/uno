/**
 * @fileoverview The keys a host holds for what runs on it: the EC2 instance
 * metadata service, and the credentials endpoint ECS and EKS Pod Identity put
 * beside a container.
 *
 * With store/s3.ts and store/sts.ts, the only modules allowed fetch. The
 * guard test in tests/store/opens.test.ts checks that. Every file read is in
 * store/node.ts, which reads the environment and a token file and passes
 * them in.
 */

import { Data, Effect } from 'effect';

import { parseTime } from '@go';
import type { Session } from './sts.ts';

/** How long a host endpoint is given to answer. One second, as the AWS SDKs give. */
const HOST_MS = 1_000;

/** Where the instance metadata service is, over IPv4 and over IPv6. */
export const IMDS_IPV4 = 'http://169.254.169.254';
export const IMDS_IPV6 = 'http://[fd00:ec2::254]';

/** How long the IMDSv2 token asked for lasts: the most the service allows. */
const TOKEN_TTL_S = 21_600;

/** Where the container endpoint is when the environment names a path on it. */
export const CONTAINER_HOST = 'http://169.254.170.2';

/** The hosts a container endpoint may be on over plain http. */
const CONTAINER_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '169.254.170.2',
  '169.254.170.23',
  '[fd00:ec2::23]',
]);

export interface HostOptions {
  /** How requests go out. Defaults to the runtime's fetch. */
  fetch?: typeof fetch;
}

/**
 * instanceCredentials asks the instance metadata service for the keys of the
 * role the instance runs as. IMDSv2 is asked first; a service that turns the
 * token request away is asked the v1 way. Undefined where nothing of the
 * kind answers, or the instance has no role, so the chain goes on to say
 * there are no credentials.
 * @param endpoint where the service is
 * @param opts how requests go out
 * @return the role's session, or undefined where nothing answers or no role is attached
 */
export async function instanceCredentials(
  endpoint: string,
  opts: HostOptions = {},
): Promise<Session | undefined> {
  const go = opts.fetch ?? fetch;
  const base = endpoint.replace(/\/+$/, '');
  const headers: Record<string, string> = {};

  let token: Response;
  try {
    token = await go(`${base}/latest/api/token`, {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': String(TOKEN_TTL_S) },
      signal: AbortSignal.timeout(HOST_MS),
    });
  } catch {
    return undefined; // nothing answered: this is not an instance
  }
  if (token.ok)
    headers['x-aws-ec2-metadata-token'] = (await token.text()).trim();
  else await token.body?.cancel(); // v2 turned off, or a proxy in the way: ask the v1 way

  const at = `${base}/latest/meta-data/iam/security-credentials/`;
  const roles = await go(at, { headers, signal: AbortSignal.timeout(HOST_MS) });
  if (!roles.ok) {
    await roles.body?.cancel();
    return undefined; // no role attached, or something other than IMDS at this address
  }
  const role = (await roles.text()).split('\n')[0]!.trim();
  if (role === '') return undefined;
  const keys = await go(at + encodeURIComponent(role), {
    headers,
    signal: AbortSignal.timeout(HOST_MS),
  });
  const who = `the instance's role ${role}`;
  if (!keys.ok) {
    await keys.body?.cancel();
    throw new InstanceRefused({ who, status: keys.status });
  }
  return Effect.runPromise(sessionIn(await keys.text(), who));
}

/** The instance metadata service named the role and would not hand out its keys. */
export class InstanceRefused extends Data.TaggedError('InstanceRefused')<{
  who: string;
  status: number;
  message: string;
}> {
  constructor(parts: { who: string; status: number }) {
    super({
      ...parts,
      message: `${parts.who}: the instance metadata service answered ${parts.status}`,
    });
  }
}

/**
 * containerCredentials asks the endpoint beside a container for the keys of
 * the task's role. `authorization` is the token the endpoint checks, where
 * it checks one. Plain http is allowed only to this host, so the token is
 * sent nowhere else.
 * @param url the endpoint
 * @param authorization the token it checks, if any
 * @param opts how requests go out
 * @return the task's session
 */
export async function containerCredentials(
  url: string,
  authorization: string | undefined,
  opts: HostOptions = {},
): Promise<Session> {
  const go = opts.fetch ?? fetch;
  const who = `the container endpoint ${url}`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NotAUrl({ who });
  }
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && CONTAINER_HOSTS.has(u.hostname))
  ) {
    throw new NotThisHost({ who });
  }
  let res: Response;
  try {
    res = await go(u, {
      headers: authorization === undefined ? {} : { authorization },
      signal: AbortSignal.timeout(HOST_MS),
    });
  } catch (err) {
    throw new NoAnswer({ who, reason: (err as Error).message });
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new HostRefused({ who, code: String(res.status) });
  }
  return Effect.runPromise(sessionIn(await res.text(), who));
}

/** The container endpoint the environment names is not a URL. */
export class NotAUrl extends Data.TaggedError('NotAUrl')<{
  who: string;
  message: string;
}> {
  constructor(parts: { who: string }) {
    super({ ...parts, message: `${parts.who} is not a URL` });
  }
}

/**
 * The container endpoint is somewhere a token may not go in the clear:
 * plain http to a host other than this one.
 */
export class NotThisHost extends Data.TaggedError('NotThisHost')<{
  who: string;
  message: string;
}> {
  constructor(parts: { who: string }) {
    super({
      ...parts,
      message: `${parts.who} is neither https nor on this host · uno sends a token to those alone`,
    });
  }
}

/**
 * Nothing answered at the endpoint within the second it is given, or the
 * connection failed. `reason` is the runtime's own account of it.
 */
export class NoAnswer extends Data.TaggedError('NoAnswer')<{
  who: string;
  reason: string;
  message: string;
}> {
  constructor(parts: { who: string; reason: string }) {
    super({
      ...parts,
      message: `${parts.who} did not answer · ${parts.reason}`,
    });
  }
}

/**
 * The endpoint turned the request away: with a status, or with the Code and
 * Message the instance metadata service puts in a body.
 */
export class HostRefused extends Data.TaggedError('HostRefused')<{
  who: string;
  code: string;
  detail?: string;
  message: string;
}> {
  constructor(parts: { who: string; code: string; detail?: string }) {
    super({
      ...parts,
      message: `${parts.who} answered ${parts.code}${parts.detail === undefined ? '' : `: ${parts.detail}`}`,
    });
  }
}

/** The endpoint answered with something other than JSON. */
export class NotJson extends Data.TaggedError('NotJson')<{
  who: string;
  message: string;
}> {
  constructor(parts: { who: string }) {
    super({ ...parts, message: `${parts.who} did not answer with JSON` });
  }
}

/** The endpoint answered with JSON that holds no keys uno could read. */
export class HostUnreadable extends Data.TaggedError('HostUnreadable')<{
  who: string;
  message: string;
}> {
  constructor(parts: { who: string }) {
    super({
      ...parts,
      message: `${parts.who} answered with no credentials uno could read`,
    });
  }
}

/** What asking the instance metadata service for its keys can fail with. */
export type InstanceFailure =
  | NoAnswer
  | InstanceRefused
  | HostRefused
  | NotJson
  | HostUnreadable;

/** What asking the container endpoint for its keys can fail with. */
export type ContainerFailure =
  | NotAUrl
  | NotThisHost
  | NoAnswer
  | HostRefused
  | NotJson
  | HostUnreadable;

/** What asking a host for its keys can fail with. */
export type HostFailure = InstanceFailure | ContainerFailure;

/**
 * sessionIn reads the JSON both endpoints answer with: AccessKeyId,
 * SecretAccessKey, Token and Expiration. IMDS adds a Code, which says
 * Success for keys it could hand out.
 * @param body the JSON answered
 * @param who the endpoint, for an error
 * @return the session the body holds
 */
function sessionIn(
  body: string,
  who: string,
): Effect.Effect<Session, HostRefused | NotJson | HostUnreadable> {
  return Effect.gen(function* () {
    const o = yield* Effect.try({
      try: () => JSON.parse(body) as Record<string, unknown>,
      catch: () => new NotJson({ who }),
    });
    const code = o['Code'];
    if (code !== undefined && code !== 'Success') {
      const message = o['Message'];
      return yield* new HostRefused({
        who,
        code: typeof code === 'string' ? code : JSON.stringify(code),
        detail: typeof message === 'string' ? message : undefined,
      });
    }
    const id = o['AccessKeyId'];
    const secret = o['SecretAccessKey'];
    const token = o['Token'];
    const expiration = parseTime(
      typeof o['Expiration'] === 'string' ? o['Expiration'] : undefined,
    );
    if (
      typeof id !== 'string' ||
      typeof secret !== 'string' ||
      typeof token !== 'string' ||
      expiration === undefined
    ) {
      return yield* new HostUnreadable({ who });
    }
    return {
      accessKeyId: id,
      secretAccessKey: secret,
      sessionToken: token,
      expiration,
    };
  });
}
