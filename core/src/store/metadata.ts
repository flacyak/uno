/**
 * @fileoverview The keys a host holds for what runs on it: the EC2 instance
 * metadata service, and the credentials endpoint ECS and EKS Pod Identity put
 * beside a container.
 *
 * With store/s3.ts and store/sts.ts, the only modules allowed fetch. The
 * guard test in tests/store/opens.test.ts checks that. Every file read is in
 * store/node.ts, which reads the environment and a token file and passes
 * them in.
 *
 * An endpoint is asked as an Effect that fails with what it said. The
 * function named for the endpoint's credentials runs it as a Promise, at
 * the store's edge.
 */

import { Data, Duration, Effect } from 'effect';

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
 * Asks the instance metadata service for the keys of the role the instance
 * runs as. IMDSv2 is asked first; a service that turns the token request
 * away is asked the v1 way. Undefined where nothing of the kind answers, or
 * the instance has no role, so the chain goes on to say there are no
 * credentials.
 * @param endpoint Where the service is.
 * @return The role's session, or undefined where nothing answers or no role
 *     is attached.
 */
export function askInstance(
  endpoint: string,
  opts: HostOptions = {},
): Effect.Effect<Session | undefined, InstanceFailure> {
  return Effect.gen(function* () {
    const go = opts.fetch ?? fetch;
    const base = endpoint.replace(/\/+$/, '');
    const service = 'the instance metadata service';

    // Nothing answering means this is not an instance.
    const token = yield* ask(go, service, `${base}/latest/api/token`, {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': String(TOKEN_TTL_S) },
    }).pipe(Effect.catchTag('NoAnswer', () => Effect.succeed(undefined)));
    if (token === undefined) return undefined;
    const headers: Record<string, string> = {};
    if (token.ok)
      headers['x-aws-ec2-metadata-token'] = (yield* text(token)).trim();
    else yield* drop(token); // v2 turned off, or a proxy in the way: ask the v1 way

    const at = `${base}/latest/meta-data/iam/security-credentials/`;
    const roles = yield* ask(go, service, at, { headers });
    if (!roles.ok) {
      yield* drop(roles);
      return undefined; // no role attached, or something other than IMDS at this address
    }
    const role = (yield* text(roles)).split('\n')[0]!.trim();
    if (role === '') return undefined;
    const keys = yield* ask(go, service, at + encodeURIComponent(role), {
      headers,
    });
    const who = `the instance's role ${role}`;
    if (!keys.ok) {
      yield* drop(keys);
      return yield* new InstanceRefused({ who, status: keys.status });
    }
    return yield* sessionIn(yield* text(keys), who);
  });
}

/**
 * Runs askInstance as a Promise, for a caller outside the store.
 * @return The role's session, or undefined where nothing answers or no role
 *     is attached.
 */
export function instanceCredentials(
  endpoint: string,
  opts: HostOptions = {},
): Promise<Session | undefined> {
  return Effect.runPromise(askInstance(endpoint, opts));
}

/**
 * The instance metadata service named the role and would not hand out its
 * keys.
 */
export class InstanceRefused extends Data.TaggedError('InstanceRefused')<{
  /** The instance's role, as the sentence names it. */
  who: string;
  status: number;
  message: string;
}> {
  /** @param parts The instance's role and the status answered. */
  constructor(parts: { who: string; status: number }) {
    super({
      ...parts,
      message: `${parts.who}: the instance metadata service answered ${parts.status}`,
    });
  }
}

/**
 * Asks the endpoint beside a container for the keys of the task's role.
 * `authorization` is the token the endpoint checks, where it checks one.
 * Plain http is allowed only to this host, so the token is sent nowhere
 * else.
 * @param url The endpoint.
 * @param authorization The token it checks, if any.
 */
export function askContainer(
  url: string,
  authorization: string | undefined,
  opts: HostOptions = {},
): Effect.Effect<Session, ContainerFailure> {
  return Effect.gen(function* () {
    const go = opts.fetch ?? fetch;
    const who = `the container endpoint ${url}`;
    const u = yield* Effect.try({
      try: () => new URL(url),
      catch: () => new NotAUrl({ who }),
    });
    if (
      u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && CONTAINER_HOSTS.has(u.hostname))
    ) {
      return yield* new NotThisHost({ who });
    }
    const res = yield* ask(go, who, u, {
      headers: authorization === undefined ? {} : { authorization },
    });
    if (!res.ok) {
      yield* drop(res);
      return yield* new HostRefused({ who, code: String(res.status) });
    }
    return yield* sessionIn(yield* text(res), who);
  });
}

/** Runs askContainer as a Promise, for a caller outside the store. */
export function containerCredentials(
  url: string,
  authorization: string | undefined,
  opts: HostOptions = {},
): Promise<Session> {
  return Effect.runPromise(askContainer(url, authorization, opts));
}

/**
 * Sends one request to a host endpoint and gives it HOST_MS to answer. It
 * fails with NoAnswer where nothing answers in time or the connection fails,
 * with the runtime's own account of it as the reason.
 * @param go How the request goes out.
 * @param who The endpoint, for the failure.
 * @param init The request's method and headers.
 */
function ask(
  go: typeof fetch,
  who: string,
  url: string | URL,
  init: RequestInit,
): Effect.Effect<Response, NoAnswer> {
  return Effect.tryPromise({
    try: (signal) => go(url, { ...init, signal }),
    catch: (err) => new NoAnswer({ who, reason: (err as Error).message }),
  }).pipe(
    Effect.timeout(Duration.millis(HOST_MS)),
    Effect.catchTag('TimeoutError', (timedOut) =>
      Effect.fail(new NoAnswer({ who, reason: timedOut.message })),
    ),
  );
}

/** Reads an answer's body as text. */
function text(res: Response): Effect.Effect<string> {
  return Effect.promise(() => res.text());
}

/** Lets go of an answer whose body is not read, so its connection is freed. */
function drop(res: Response): Effect.Effect<void> {
  return Effect.promise(async () => {
    await res.body?.cancel();
  });
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
