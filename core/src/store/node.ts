/**
 * @fileoverview The Node FileStore, the handler that opens a file on this
 * machine's disks, and the AWS credential chain: the environment, ~/.aws,
 * then the host the process runs on.
 *
 * `write` builds a sibling temp file, fsyncs it and renames it over the
 * target. Only this file and store/disklister.ts import node:fs. The guard
 * test in tests/store/opens.test.ts checks that.
 *
 * The chain runs as Effects, each step failing with the classes declared
 * beside it, and ChainFailure names them all. The exported functions run
 * the chain with Effect.runPromise, which rejects with the very failure, so
 * a caller reads the same sentence from a Promise as before.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { Data, Effect } from 'effect';

import { compareStrings, parseTime } from '@go';
import type { AuthMode, Connection } from '@library';
import { covering } from '@library';
import type { Provider } from '@plugin';
import { diskLister } from './disklister.ts';
import type { ByteSource, FileHandler, FileStore } from './index.ts';
import { isRemote, readAll } from './index.ts';
import {
  CONTAINER_HOST,
  IMDS_IPV4,
  IMDS_IPV6,
  askContainer,
  askInstance,
} from './metadata.ts';
import type { ContainerFailure, InstanceFailure } from './metadata.ts';
import type { AwsCredentials, S3Location, Signing } from './s3.ts';
import {
  NotSignedIn,
  assumeRole,
  roleExchange,
  ssoExchange,
  webIdentityExchange,
} from './sts.ts';
import type { Session, SsoFailure, StsFailure } from './sts.ts';
import { unreachable } from '@never';

/**
 * localFiles opens files on this machine's disks by path, for reading. It
 * claims every scheme-free path.
 * @return the handler
 */
export function localFiles(): FileHandler {
  return {
    label: 'local files',
    handles: (ref) => 'path' in ref && !isRemote(ref.path),
    open: (ref) =>
      'path' in ref
        ? nodeSource(ref.path)
        : Promise.reject(
            new Error(`${ref.name}: local files are opened by path`),
          ),
  };
}

/**
 * diskProvider is this machine's disks: localFiles and diskLister.
 * @return the provider
 */
export function diskProvider(): Provider {
  return {
    name: 'disk',
    label: 'local files',
    files: localFiles(),
    browse: diskLister(),
  };
}

/**
 * nodeSource opens a file and reads it at an offset through one descriptor.
 * Positional reads share the descriptor, so reads can be in flight together.
 *
 * Only a regular file opens. The open is non-blocking so a fifo returns at
 * once, and the stat after it refuses everything but a regular file.
 * @param path the file to open
 * @return a source that reads the file by offset
 */
export async function nodeSource(path: string): Promise<ByteSource> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let size: number;
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error(
        `${path} is ${st.isDirectory() ? 'a folder' : 'not a regular file'}`,
      );
    }
    size = st.size;
  } catch (err) {
    await fh.close();
    throw err;
  }

  return {
    size,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const want = Math.max(0, Math.min(length, size - offset));
      const buf = new Uint8Array(want);
      let got = 0;
      // A read may return fewer bytes than asked while more remain.
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
        if (bytesRead === 0) break; // the file shrank since it was opened
        got += bytesRead;
      }
      return got === want ? buf : buf.subarray(0, got);
    },
    close: () => fh.close(),
  };
}

/**
 * nodeStore is a FileStore backed by the local filesystem.
 * @return the store
 */
export function nodeStore(): FileStore {
  return {
    files: [localFiles()],

    /**
     * write replaces the file at path atomically: the bytes go to a temp file
     * in the same directory, which is fsynced and renamed over the target. A
     * failure leaves the previous file untouched and removes the temp
     * directory.
     * @param path the file to replace
     * @param bytes what to write
     */
    async write(path: string, bytes: Uint8Array): Promise<void> {
      const dir = dirname(path);
      const scratch = await mkdtemp(join(dir, '.uno-'));
      const tmp = join(scratch, 'part');

      try {
        // 0644: the result is an ordinary user file.
        const fh = await open(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644,
        );
        try {
          await fh.writeFile(bytes);
          await fh.sync(); // durable before the swap
        } finally {
          await fh.close();
        }
        await rename(tmp, path);
      } catch (err) {
        await rm(scratch, { recursive: true, force: true }); // a failed write cleans up after itself
        throw err;
      }
      await rm(scratch, { recursive: true, force: true });
    },

    /**
     * list names the files directly in dir. A missing directory is an empty
     * list.
     * @param dir the directory to list
     * @return the names of the files in it
     */
    async list(dir: string): Promise<string[]> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => !e.isDirectory()).map((e) => e.name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
  };
}

const execFileAsync = promisify(execFile);

/** How long credentials read from disk are reused before they are read again. */
const CREDENTIALS_MS = 60_000;

/** The fallback region a request is signed for. */
const DEFAULT_REGION = 'us-east-1';

type Env = Record<string, string | undefined>;

/** The two files the AWS CLI reads, as sections of keys. */
interface AwsFiles {
  /** ~/.aws/config, where a named profile's section is `profile <name>`. */
  config: Map<string, Map<string, string>>;
  /** ~/.aws/credentials, where it is `<name>`. */
  credentials: Map<string, Map<string, string>>;
}

/**
 * Reads the AWS files from the paths the environment names, or ~/.aws.
 * @param env the environment, for the paths and the home folder
 * @return both files, as sections of keys
 */
async function awsFiles(env: Env): Promise<AwsFiles> {
  const aws = join(homeOf(env), '.aws');
  return {
    config: await ini(env['AWS_CONFIG_FILE'] ?? join(aws, 'config')),
    credentials: await ini(
      env['AWS_SHARED_CREDENTIALS_FILE'] ?? join(aws, 'credentials'),
    ),
  };
}

/**
 * The config section a profile's settings are in: `default`, or
 * `profile <name>`.
 * @param files the AWS files
 * @param profile the profile's name
 * @return its config section, or undefined
 */
function configOf(
  files: AwsFiles,
  profile: string,
): Map<string, string> | undefined {
  return files.config.get(
    profile === 'default' ? 'default' : `profile ${profile}`,
  );
}

/**
 * The region a profile signs for: the environment, then its config, then
 * the default.
 * @param env the environment
 * @param files the AWS files
 * @param profile the profile's name
 * @return the region
 */
function regionOf(env: Env, files: AwsFiles, profile: string): string {
  return (
    envRegion(env) ?? configOf(files, profile)?.get('region') ?? DEFAULT_REGION
  );
}

/**
 * The region the environment names, or undefined.
 * @param env the environment
 * @return the region, or undefined
 */
function envRegion(env: Env): string | undefined {
  return env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'];
}

/**
 * envKeys is the keys in the environment, signing for `region`, or undefined
 * where there are none. An empty variable counts as none.
 * @param env the environment
 * @param region the region the keys sign for
 * @return the keys, or undefined
 */
function envKeys(env: Env, region: string): AwsCredentials | undefined {
  const id = env['AWS_ACCESS_KEY_ID'];
  const secret = env['AWS_SECRET_ACCESS_KEY'];
  if (id === undefined || id === '' || secret === undefined || secret === '')
    return undefined;
  const sessionToken = env['AWS_SESSION_TOKEN'];
  return { accessKeyId: id, secretAccessKey: secret, sessionToken, region };
}

/** Credentials, and the time after which they are read again. */
interface Held {
  creds: AwsCredentials;
  until: number;
}

/**
 * How long before temporary credentials expire they are replaced, so a request
 * is signed with keys that outlast it. Five minutes, as the AWS SDKs use.
 */
const EARLY_MS = 5 * 60_000;

/**
 * The home folder the AWS files are under.
 * @param env the environment
 * @return the home folder
 */
function homeOf(env: Env): string {
  return env['HOME'] ?? env['USERPROFILE'] ?? homedir();
}

/**
 * What the credential chain can fail with, from any step: a profile's
 * settings, its credential_process or SSO sign-in, the host's endpoints, the
 * STS exchange, or the chain having nothing at all.
 */
export type ChainFailure =
  | TokenFileMissing
  | MfaRefused
  | SourceLoop
  | SourceNoWayIn
  | CredentialSourceEmpty
  | CredentialSourceUnknown
  | NoSourceProfile
  | ProcessFailure
  | SsoSessionMissing
  | SsoSettingMissing
  | SsoFailure
  | StsFailure
  | ContainerFailure
  | InstanceFailure
  | NoCredentials
  | NoSuchProfile
  | ProfileNoWayIn;

/**
 * Signs in as one named profile the way the AWS CLI does, when the profile
 * offers one of the ways below, and returns undefined otherwise.
 *
 * In order: a role_arn is assumed through its source. Static keys in
 * ~/.aws/credentials or the config section are used as they are and read
 * again after a minute. A credential_process is run and its output read. An
 * SSO profile trades its cached token for keys. Expiring keys are reused
 * until shortly before they expire.
 * @param profile The profile to sign in as.
 * @param through The profiles already on a role chain, so a loop is refused.
 * @return The session, or undefined where the profile offers no way in.
 */
function profileSession(
  env: Env,
  files: AwsFiles,
  profile: string,
  through: readonly string[] = [],
): Effect.Effect<Held | undefined, ChainFailure> {
  return Effect.gen(function* () {
    const p = files.credentials.get(profile);
    const fromConfig = configOf(files, profile);
    const region = regionOf(env, files, profile);
    const as = `the AWS profile ${profile}`;

    // A profile with role_arn is the role, whatever else it holds, as for the
    // CLI.
    const roleArn = fromConfig?.get('role_arn') ?? p?.get('role_arn');
    if (roleArn !== undefined) {
      const setting = (key: string): string | undefined =>
        fromConfig?.get(key) ?? p?.get(key);
      const session = yield* roleSession(
        env,
        files,
        profile,
        roleArn,
        setting,
        through,
      );
      return held(session, region, as);
    }

    const own = profileKeysOnly(env, files, profile);
    if (own !== undefined)
      return { creds: { ...own.creds, as }, until: own.until };
    const command = fromConfig?.get('credential_process');
    if (command !== undefined)
      return held(yield* processCredentials(profile, command), region, as);
    if (
      fromConfig?.has('sso_session') === true ||
      fromConfig?.has('sso_start_url') === true
    ) {
      return held(
        yield* ssoSession(env, files, profile, fromConfig),
        region,
        as,
      );
    }
    return undefined;
  });
}

/**
 * held is a session kept until shortly before it expires, or for good for
 * keys that last, signing for `region`. `as` names whose it is.
 * @param session the keys, with when they expire
 * @param region the region they sign for
 * @param as whose they are, for an error
 * @return the credentials, kept until shortly before they expire
 */
function held(
  { expiration, ...keys }: Printed | Session,
  region: string,
  as?: string,
): Held {
  const until =
    expiration === undefined ? Infinity : expiration.getTime() - EARLY_MS;
  return {
    creds: { ...keys, region, ...(as === undefined ? {} : { as }) },
    until,
  };
}

/**
 * Asks the host, where the chain ends and the AWS SDKs look last: a web
 * identity token the environment names, the endpoint beside a container,
 * then the instance metadata service. Undefined where the host offers none.
 * @param region The region the session signs for.
 * @return The host's session, or undefined.
 */
function hostSession(
  env: Env,
  region: string,
): Effect.Effect<
  Held | undefined,
  TokenFileMissing | StsFailure | ContainerFailure | InstanceFailure
> {
  return Effect.gen(function* () {
    const tokenFile = envVar(env, 'AWS_WEB_IDENTITY_TOKEN_FILE');
    const roleArn = envVar(env, 'AWS_ROLE_ARN');
    if (tokenFile !== undefined && roleArn !== undefined) {
      const ask = {
        roleArn,
        tokenFile,
        sessionName: envVar(env, 'AWS_ROLE_SESSION_NAME'),
        region,
      };
      return held(
        yield* webIdentitySession(env, ask, 'the environment'),
        region,
      );
    }
    const session =
      (yield* containerSession(env)) ?? (yield* instanceSession(env));
    return session === undefined ? undefined : held(session, region);
  });
}

/**
 * A token file that is not there: a web identity token or a container
 * endpoint's token, named by the environment or by a profile.
 */
export class TokenFileMissing extends Data.TaggedError('TokenFileMissing')<{
  /** Who names the file: the environment, or `the AWS profile x`. */
  named: string;
  kind: 'web identity' | 'container';
  file: string;
  message: string;
}> {
  /**
   * @param parts Who names the file, which kind it is, and where it was
   *     looked for.
   */
  constructor(parts: {
    named: string;
    kind: 'web identity' | 'container';
    file: string;
  }) {
    super({
      ...parts,
      message: `${parts.named} names the ${parts.kind} token file ${parts.file}, which is not there`,
    });
  }
}

/** What a web identity session is asked for, and where its token is. */
interface WebIdentityFile {
  roleArn: string;
  tokenFile: string;
  sessionName?: string;
  durationSeconds?: number;
  region: string;
}

/**
 * Reads the token in the file and trades it at STS for the role.
 * @param env The environment, for the STS endpoint.
 * @param named Who names the file, for an error: the AWS profile x, or the
 *     environment.
 */
function webIdentitySession(
  env: Env,
  ask: WebIdentityFile,
  named: string,
): Effect.Effect<Session, TokenFileMissing | StsFailure> {
  return Effect.gen(function* () {
    const token = yield* Effect.promise(() => readText(ask.tokenFile));
    if (token === undefined) {
      return yield* new TokenFileMissing({
        named,
        kind: 'web identity',
        file: ask.tokenFile,
      });
    }
    return yield* webIdentityExchange(
      {
        roleArn: ask.roleArn,
        sessionName: ask.sessionName ?? `uno-${Date.now()}`,
        token: token.trim(),
        durationSeconds: ask.durationSeconds,
        region: ask.region,
      },
      { endpoint: env['AWS_ENDPOINT_URL_STS'] },
    );
  });
}

/**
 * Asks the endpoint the environment names beside a container: a path on the
 * ECS host, or a full URL. Undefined off a container. The endpoint's token
 * comes from a file where one is named.
 * @return The task's session, or undefined off a container.
 */
function containerSession(
  env: Env,
): Effect.Effect<Session | undefined, TokenFileMissing | ContainerFailure> {
  return Effect.gen(function* () {
    const relative = envVar(env, 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
    const url =
      relative === undefined
        ? envVar(env, 'AWS_CONTAINER_CREDENTIALS_FULL_URI')
        : CONTAINER_HOST + relative;
    if (url === undefined) return undefined;
    const tokenFile = envVar(env, 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE');
    let authorization = envVar(env, 'AWS_CONTAINER_AUTHORIZATION_TOKEN');
    if (tokenFile !== undefined) {
      const text = yield* Effect.promise(() => readText(tokenFile));
      if (text === undefined) {
        return yield* new TokenFileMissing({
          named: 'the environment',
          kind: 'container',
          file: tokenFile,
        });
      }
      authorization = text.trim();
    }
    return yield* askContainer(url, authorization);
  });
}

/**
 * Asks the instance metadata service, at the endpoint the environment names
 * or the one its mode picks, unless the environment turns it off. Undefined
 * where no role answers.
 * @return The instance's session, or undefined.
 */
function instanceSession(
  env: Env,
): Effect.Effect<Session | undefined, InstanceFailure> {
  if (env['AWS_EC2_METADATA_DISABLED']?.toLowerCase() === 'true')
    return Effect.succeed(undefined);
  const ipv6 =
    env['AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE']?.toLowerCase() === 'ipv6';
  const endpoint =
    envVar(env, 'AWS_EC2_METADATA_SERVICE_ENDPOINT') ??
    (ipv6 ? IMDS_IPV6 : IMDS_IPV4);
  return askInstance(endpoint);
}

/**
 * The environment's value for `name`, where it is set and not empty.
 * @param env the environment
 * @param name the variable
 * @return its value, or undefined
 */
function envVar(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** A profile that names an sso-session section ~/.aws/config does not have. */
export class SsoSessionMissing extends Data.TaggedError('SsoSessionMissing')<{
  profile: string;
  named: string;
  message: string;
}> {
  constructor(parts: { profile: string; named: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile} names sso-session ${parts.named}, which ~/.aws/config does not have`,
    });
  }
}

/** An SSO profile with one of its four settings left out. */
export class SsoSettingMissing extends Data.TaggedError('SsoSettingMissing')<{
  profile: string;
  setting: string;
  message: string;
}> {
  constructor(parts: { profile: string; setting: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile} signs in through SSO and has no ${parts.setting}`,
    });
  }
}

/**
 * ssoSession reads the token `aws sso login` cached for a profile and trades
 * it at the SSO portal for the profile's role.
 *
 * The portal is named in one of two layouts: an `[sso-session <name>]`
 * section the profile names with sso_session, cached under the SHA-1 of that
 * name, or sso_start_url and sso_region in the profile itself, cached under
 * the SHA-1 of the URL. A missing or expired token is refused with the
 * command that fixes it, before the portal is asked.
 * @param env the environment
 * @param files the AWS files
 * @param profile the profile's name
 * @param section the profile's config section
 * @return the role's session
 */
function ssoSession(
  env: Env,
  files: AwsFiles,
  profile: string,
  section: Map<string, string>,
): Effect.Effect<Session, SsoSessionMissing | SsoSettingMissing | SsoFailure> {
  return Effect.gen(function* () {
    const named = section.get('sso_session');
    let portal = section;
    if (named !== undefined) {
      const found = files.config.get(`sso-session ${named}`);
      if (found === undefined)
        return yield* new SsoSessionMissing({ profile, named });
      portal = found;
    }
    const startUrl = portal.get('sso_start_url');
    const ssoRegion = portal.get('sso_region');
    const accountId = section.get('sso_account_id');
    const roleName = section.get('sso_role_name');
    const missing = [
      ['sso_start_url', startUrl],
      ['sso_region', ssoRegion],
      ['sso_account_id', accountId],
      ['sso_role_name', roleName],
    ].find(([, v]) => v === undefined)?.[0];
    if (missing !== undefined)
      return yield* new SsoSettingMissing({ profile, setting: missing });

    const accessToken = yield* cachedSignIn(env, profile, named ?? startUrl!);
    return yield* ssoExchange(
      {
        profile,
        region: ssoRegion!,
        accountId: accountId!,
        roleName: roleName!,
        accessToken,
      },
      { endpoint: env['AWS_ENDPOINT_URL_SSO'] },
    );
  });
}

/**
 * cachedSignIn is the access token `aws sso login` cached under `cacheKey`
 * in ~/.aws/sso/cache. A token that is missing, unreadable or expired fails
 * with NotSignedIn, which says how to sign in again.
 * @param env the environment, for the home folder
 * @param profile the profile, for the refusal
 * @param cacheKey the sso-session name or start URL the token is cached under
 * @return the access token
 */
function cachedSignIn(
  env: Env,
  profile: string,
  cacheKey: string,
): Effect.Effect<string, NotSignedIn> {
  return Effect.gen(function* () {
    const name = createHash('sha1').update(cacheKey).digest('hex') + '.json';
    const path = join(homeOf(env), '.aws', 'sso', 'cache', name);
    const text = yield* Effect.promise(() => readText(path));
    if (text === undefined) {
      return yield* new NotSignedIn({
        profile,
        why: 'uno found no SSO sign-in for it',
      });
    }
    // A cache file that fails to parse is refused like a missing sign-in.
    const token = cachedToken(text);
    // Older CLIs wrote the time with a UTC suffix, where newer write Z.
    const expires = parseTime(String(token?.expiresAt).replace(/UTC$/, 'Z'));
    if (typeof token?.accessToken !== 'string' || expires === undefined) {
      return yield* new NotSignedIn({
        profile,
        why: 'its cached SSO sign-in could not be read',
      });
    }
    if (expires.getTime() <= Date.now()) {
      return yield* new NotSignedIn({
        profile,
        why: `its SSO sign-in expired at ${expires.toISOString()}`,
      });
    }
    return token.accessToken;
  });
}

/**
 * The JSON object a cache file holds, or undefined.
 * @param text the file's text
 * @return the object, or undefined
 */
function cachedToken(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * A role profile with mfa_serial, which asks for a code uno has no prompt
 * for. The sentence says how to sign in from a shell instead.
 */
export class MfaRefused extends Data.TaggedError('MfaRefused')<{
  profile: string;
  roleArn: string;
  message: string;
}> {
  constructor(parts: { profile: string; roleArn: string }) {
    super({
      ...parts,
      message:
        `the AWS profile ${parts.profile} asks for an MFA code to assume ${parts.roleArn}, which uno cannot ask for · ` +
        `run \`aws configure export-credentials --profile ${parts.profile} --format env\` and start uno from that shell`,
    });
  }
}

/**
 * A chain of source profiles that comes back to one already on it. `chain`
 * is the whole loop, ending with the profile it came back to.
 */
export class SourceLoop extends Data.TaggedError('SourceLoop')<{
  profile: string;
  chain: readonly string[];
  message: string;
}> {
  constructor(parts: { profile: string; chain: readonly string[] }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile} takes its credentials from a loop · ${parts.chain.join(' → ')}`,
    });
  }
}

/** A source_profile that offers no way in uno can use. */
export class SourceNoWayIn extends Data.TaggedError('SourceNoWayIn')<{
  profile: string;
  sourceProfile: string;
  message: string;
}> {
  constructor(parts: { profile: string; sourceProfile: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile} takes its credentials from ${parts.sourceProfile}, which has no way in uno can use`,
    });
  }
}

/** The three credential_source settings uno knows. */
type CredentialSource = 'Environment' | 'Ec2InstanceMetadata' | 'EcsContainer';

/** What each credential_source is called when it has nothing to give. */
const SOURCE_EMPTY: Record<CredentialSource, string> = {
  Environment:
    'the environment, which has no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
  Ec2InstanceMetadata:
    'the instance it runs on, and no instance metadata service with a role answered',
  EcsContainer:
    'its container, and the environment names no container endpoint',
};

/** A credential_source uno knows, with nothing in it to assume the role with. */
export class CredentialSourceEmpty extends Data.TaggedError(
  'CredentialSourceEmpty',
)<{
  profile: string;
  source: CredentialSource;
  message: string;
}> {
  constructor(parts: { profile: string; source: CredentialSource }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile} takes its credentials from ${SOURCE_EMPTY[parts.source]}`,
    });
  }
}

/** A role profile with neither a source_profile nor a credential_source. */
export class NoSourceProfile extends Data.TaggedError('NoSourceProfile')<{
  profile: string;
  message: string;
}> {
  constructor(parts: { profile: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile} names a role_arn and no source_profile to assume it with`,
    });
  }
}

/** A credential_source other than the three uno knows. */
export class CredentialSourceUnknown extends Data.TaggedError(
  'CredentialSourceUnknown',
)<{
  profile: string;
  source: string;
  message: string;
}> {
  constructor(parts: { profile: string; source: string }) {
    super({
      ...parts,
      message:
        `the AWS profile ${parts.profile} takes its credentials from ${parts.source}, which uno does not know · ` +
        'use source_profile, or a credential_source of Environment, Ec2InstanceMetadata or EcsContainer',
    });
  }
}

/**
 * fromSourceProfile is the credentials of a role profile's source_profile,
 * which may be any kind of profile, including another role. A source already
 * on the chain is refused naming the loop, and one with no way in is refused
 * by name. A profile that is its own source means the static keys beside its
 * role_arn.
 * @param env the environment
 * @param files the AWS files
 * @param profile the profile naming the role
 * @param sourceProfile its source_profile
 * @param chain the profiles on the chain so far, `profile` last
 * @return the source's credentials
 */
function fromSourceProfile(
  env: Env,
  files: AwsFiles,
  profile: string,
  sourceProfile: string,
  chain: readonly string[],
): Effect.Effect<Omit<AwsCredentials, 'region'>, ChainFailure> {
  return Effect.gen(function* () {
    if (chain.includes(sourceProfile))
      return yield* new SourceLoop({
        profile,
        chain: [...chain, sourceProfile],
      });
    const found =
      sourceProfile === profile
        ? profileKeysOnly(env, files, profile)
        : yield* profileSession(env, files, sourceProfile, chain);
    if (found === undefined)
      return yield* new SourceNoWayIn({ profile, sourceProfile });
    return found.creds;
  });
}

/**
 * fromCredentialSource is the credentials of the credential_source a role
 * profile names: the environment's keys, the instance's role, or the
 * container's. A source with nothing in it, one uno does not know, and a
 * profile naming no source at all are each refused by name.
 * @param env the environment
 * @param profile the profile naming the role
 * @param credentialSource its credential_source, if any
 * @return the source's credentials
 */
function fromCredentialSource(
  env: Env,
  profile: string,
  credentialSource: string | undefined,
): Effect.Effect<
  Omit<AwsCredentials, 'region'>,
  | CredentialSourceEmpty
  | CredentialSourceUnknown
  | NoSourceProfile
  | TokenFileMissing
  | ContainerFailure
  | InstanceFailure
> {
  return Effect.gen(function* () {
    if (credentialSource === 'Environment') {
      const found = envKeys(env, DEFAULT_REGION);
      if (found === undefined)
        return yield* new CredentialSourceEmpty({
          profile,
          source: 'Environment',
        });
      return found;
    }
    if (credentialSource === 'Ec2InstanceMetadata') {
      const session = yield* instanceSession(env);
      if (session === undefined)
        return yield* new CredentialSourceEmpty({
          profile,
          source: 'Ec2InstanceMetadata',
        });
      return session;
    }
    if (credentialSource === 'EcsContainer') {
      const session = yield* containerSession(env);
      if (session === undefined)
        return yield* new CredentialSourceEmpty({
          profile,
          source: 'EcsContainer',
        });
      return session;
    }
    if (credentialSource !== undefined)
      return yield* new CredentialSourceUnknown({
        profile,
        source: credentialSource,
      });
    return yield* new NoSourceProfile({ profile });
  });
}

/**
 * roleSession assumes the role a profile names with the credentials of its
 * source_profile, which may be any kind of profile, including another role.
 * A chain that comes back to a profile already on it is refused naming the
 * loop. mfa_serial is refused, since a code needs a prompt the engine lacks.
 * @param env the environment
 * @param files the AWS files
 * @param profile the profile naming the role
 * @param roleArn the role
 * @param setting reads a key from the profile's sections
 * @param through the profiles already on the chain
 * @return the role's session
 */
function roleSession(
  env: Env,
  files: AwsFiles,
  profile: string,
  roleArn: string,
  setting: (key: string) => string | undefined,
  through: readonly string[],
): Effect.Effect<Session, ChainFailure> {
  return Effect.gen(function* () {
    const chain = [...through, profile];
    if (setting('mfa_serial') !== undefined)
      return yield* new MfaRefused({ profile, roleArn });

    // A profile with a web identity token has no source: the token says who
    // is asking.
    const tokenFile = setting('web_identity_token_file');
    if (tokenFile !== undefined) {
      const duration = setting('duration_seconds');
      const ask: WebIdentityFile = {
        roleArn,
        tokenFile,
        sessionName: setting('role_session_name'),
        durationSeconds: duration === undefined ? undefined : Number(duration),
        region: regionOf(env, files, profile),
      };
      return yield* webIdentitySession(env, ask, `the AWS profile ${profile}`);
    }

    const sourceProfile = setting('source_profile');
    const source =
      sourceProfile === undefined
        ? yield* fromCredentialSource(
            env,
            profile,
            setting('credential_source'),
          )
        : yield* fromSourceProfile(env, files, profile, sourceProfile, chain);

    const duration = setting('duration_seconds');
    return yield* roleExchange(
      {
        roleArn,
        sessionName: setting('role_session_name') ?? `uno-${Date.now()}`,
        externalId: setting('external_id'),
        durationSeconds: duration === undefined ? undefined : Number(duration),
        region: regionOf(env, files, profile),
      },
      source,
      { endpoint: env['AWS_ENDPOINT_URL_STS'] },
    );
  });
}

/**
 * A profile's own static keys, for a role profile that is its own source.
 * @param env the environment
 * @param files the AWS files
 * @param profile the profile's name
 * @return the keys, or undefined
 */
function profileKeysOnly(
  env: Env,
  files: AwsFiles,
  profile: string,
): Held | undefined {
  const p = files.credentials.get(profile);
  const fromConfig = configOf(files, profile);
  const key =
    p?.get('aws_access_key_id') ?? fromConfig?.get('aws_access_key_id');
  const secret =
    p?.get('aws_secret_access_key') ?? fromConfig?.get('aws_secret_access_key');
  if (key === undefined || secret === undefined) return undefined;
  const token =
    p?.get('aws_session_token') ?? fromConfig?.get('aws_session_token');
  return {
    creds: {
      accessKeyId: key,
      secretAccessKey: secret,
      sessionToken: token,
      region: regionOf(env, files, profile),
    },
    until: Date.now() + CREDENTIALS_MS,
  };
}

/** How long a credential_process program is given to answer. */
const PROCESS_MS = 30_000;

/** The most a credential_process program may print. */
const PROCESS_BYTES = 1 << 20;

/** A profile whose credential_process is set to nothing. */
export class ProcessEmpty extends Data.TaggedError('ProcessEmpty')<{
  profile: string;
  message: string;
}> {
  constructor(parts: { profile: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile} has an empty credential_process`,
    });
  }
}

/**
 * A credential_process that did not run to a good end: there is no such
 * program, it ran out of time, or it failed, with the first line it wrote to
 * stderr as `why`.
 */
export class ProcessFailed extends Data.TaggedError('ProcessFailed')<{
  profile: string;
  why: string;
  message: string;
}> {
  constructor(parts: { profile: string; why: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile}'s credential_process failed · ${parts.why}`,
    });
  }
}

/**
 * A credential_process that ran and printed something other than the CLI's
 * version 1 JSON: `why` says what was wrong with it.
 */
export class ProcessUnreadable extends Data.TaggedError('ProcessUnreadable')<{
  profile: string;
  why: string;
  message: string;
}> {
  constructor(parts: { profile: string; why: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile}'s credential_process ${parts.why}`,
    });
  }
}

/** What running a credential_process can fail with. */
export type ProcessFailure = ProcessEmpty | ProcessFailed | ProcessUnreadable;

/** Keys a credential_process printed, and when they expire where it said. */
interface Printed {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/**
 * processCredentials runs a profile's credential_process and reads the keys
 * it prints. The command is split into words the way a shell would and run
 * directly, as a program and its arguments. The output must be the CLI's
 * version 1 JSON.
 * @param profile the profile, for errors
 * @param command the credential_process line
 * @return the keys printed
 */
function processCredentials(
  profile: string,
  command: string,
): Effect.Effect<Printed, ProcessFailure> {
  return Effect.gen(function* () {
    /** fail is the refusal of what this profile's credential_process printed. */
    const fail = (why: string): ProcessUnreadable =>
      new ProcessUnreadable({ profile, why });
    const words = splitCommand(command);
    const [program, ...args] = words;
    if (program === undefined) return yield* new ProcessEmpty({ profile });
    const out = yield* runProcess(profile, program, args);

    const o = yield* Effect.try({
      try: () => JSON.parse(out) as Record<string, unknown>,
      catch: () => fail('did not print JSON'),
    });
    if (o['Version'] !== 1) {
      return yield* fail(
        `printed version ${JSON.stringify(o['Version'])} · uno reads version 1`,
      );
    }
    const id = o['AccessKeyId'];
    const secret = o['SecretAccessKey'];
    if (typeof id !== 'string' || typeof secret !== 'string') {
      return yield* fail('printed no AccessKeyId and SecretAccessKey');
    }
    const printed: Printed = { accessKeyId: id, secretAccessKey: secret };
    if (typeof o['SessionToken'] === 'string')
      printed.sessionToken = o['SessionToken'];
    if (typeof o['Expiration'] === 'string') {
      const at = parseTime(o['Expiration']);
      if (at === undefined)
        return yield* fail('printed an Expiration uno cannot read');
      printed.expiration = at;
    }
    return printed;
  });
}

/**
 * runProcess runs a credential_process program with its arguments and gives
 * it PROCESS_MS to answer, succeeding with what it printed. It fails with
 * ProcessFailed where there is no such program, it ran out of time, or it
 * failed: the first line it wrote to stderr says why.
 * @param profile the profile, for the failure
 * @param program the program
 * @param args its arguments
 * @return what the program printed
 */
function runProcess(
  profile: string,
  program: string,
  args: readonly string[],
): Effect.Effect<string, ProcessFailed> {
  return Effect.tryPromise({
    try: async () => {
      const run = await execFileAsync(program, args, {
        timeout: PROCESS_MS,
        maxBuffer: PROCESS_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      });
      return run.stdout;
    },
    catch: (err) => {
      const e = err as NodeJS.ErrnoException & {
        stderr?: string;
        killed?: boolean;
      };
      let why: string;
      if (e.code === 'ENOENT') why = `there is no program called ${program}`;
      else if (e.killed === true)
        why = `it did not answer within ${PROCESS_MS / 1000} seconds`;
      else why = (e.stderr?.trim().split('\n')[0] ?? '') || e.message;
      return new ProcessFailed({ profile, why });
    },
  });
}

/**
 * splitCommand splits a command line into words the way a POSIX shell would,
 * and that is all of the shell it has: single quotes keep everything, double
 * quotes keep everything but a backslash before a quote or a backslash, and
 * a backslash outside quotes keeps the next character. Every other character
 * is plain text: a `$`, a `*` and a semicolon are each part of a word.
 * @param line the command line
 * @return its words
 */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let open = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0)
        throw new Error(`credential_process has a ' with no ' to close it`);
      word += line.slice(i + 1, end);
      i = end;
      open = true;
    } else if (c === '"') {
      open = true;
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\'))
          i++;
        word += line[i];
      }
      if (i >= line.length)
        throw new Error(`credential_process has a " with no " to close it`);
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      open = true;
    } else if (/\s/.test(c)) {
      if (open) words.push(word);
      word = '';
      open = false;
    } else {
      word += c;
      open = true;
    }
  }
  if (open) words.push(word);
  return words;
}

/**
 * cached reuses what `read` returned until its `until` time passes. Calls
 * that land while a read is in flight share it. A read that fails rejects
 * every waiting call and is dropped, so the next call reads again.
 * @param read reads credentials and says when to read again
 * @return a function answering the kept credentials
 */
function cached(read: () => Promise<Held>): () => Promise<AwsCredentials> {
  let kept: Held | undefined;
  let reading: Promise<Held> | undefined;
  return async () => {
    if (kept !== undefined && Date.now() < kept.until) return kept.creds;
    reading ??= read().then(
      (held) => {
        kept = held;
        reading = undefined;
        return held;
      },
      (err: unknown) => {
        reading = undefined;
        throw err;
      },
    );
    return (await reading).creds;
  };
}

/**
 * No source in the chain had credentials: not the environment, not the
 * profile, not the host. The sentence says where to put some.
 */
export class NoCredentials extends Data.TaggedError('NoCredentials')<{
  profile: string;
  message: string;
}> {
  constructor(parts: { profile: string }) {
    super({
      ...parts,
      message:
        `no AWS credentials · set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, ` +
        `put keys for the ${parts.profile} profile in ~/.aws/credentials, or run uno where a role is attached`,
    });
  }
}

/**
 * awsCredentials finds credentials the way the AWS CLI does: the environment
 * first, then the profile AWS_PROFILE or AWS_DEFAULT_PROFILE names, or
 * `default`, then the host the process runs on. This is the `machine` way
 * of signing in, and what a request outside every connection signs with.
 * @param env the environment, process.env by default
 * @return a function answering the credentials, reading again as they age
 */
export function awsCredentials(
  env: Env = process.env,
): () => Promise<AwsCredentials> {
  return cached(() => Effect.runPromise(machineChain(env)));
}

/**
 * machineChain is the chain awsCredentials reads, as one Effect: the
 * environment, the profile, then the host, failing with NoCredentials where
 * none of them has any.
 * @param env the environment
 * @return the credentials, kept until shortly before they expire
 */
function machineChain(env: Env): Effect.Effect<Held, ChainFailure> {
  return Effect.gen(function* () {
    const profile =
      env['AWS_PROFILE'] ?? env['AWS_DEFAULT_PROFILE'] ?? 'default';
    const files = yield* Effect.promise(() => awsFiles(env));
    const region = regionOf(env, files, profile);
    const fromEnv = envKeys(env, region);
    if (fromEnv !== undefined)
      return { creds: fromEnv, until: Date.now() + CREDENTIALS_MS };
    const fromProfile = yield* profileSession(env, files, profile);
    if (fromProfile !== undefined) return fromProfile;
    const fromHost = yield* hostSession(env, region);
    if (fromHost !== undefined) return fromHost;
    return yield* new NoCredentials({ profile });
  });
}

/** A profile neither ~/.aws/config nor ~/.aws/credentials has a section for. */
export class NoSuchProfile extends Data.TaggedError('NoSuchProfile')<{
  profile: string;
  message: string;
}> {
  constructor(parts: { profile: string }) {
    super({
      ...parts,
      message: `there is no AWS profile called ${parts.profile} in ~/.aws/config or ~/.aws/credentials`,
    });
  }
}

/**
 * A profile that is there and offers none of the ways in uno can use. The
 * sentence names them.
 */
export class ProfileNoWayIn extends Data.TaggedError('ProfileNoWayIn')<{
  profile: string;
  message: string;
}> {
  constructor(parts: { profile: string }) {
    super({
      ...parts,
      message: `the AWS profile ${parts.profile} has no way in uno can use · give it keys in ~/.aws/credentials, a credential_process, or an SSO sign-in`,
    });
  }
}

/**
 * profileCredentials signs in as one named profile, ignoring AWS_PROFILE and
 * any keys in the environment.
 * @param profile the profile to sign in as
 * @param env the environment, process.env by default
 * @return a function answering the credentials, reading again as they age
 */
export function profileCredentials(
  profile: string,
  env: Env = process.env,
): () => Promise<AwsCredentials> {
  return cached(() => Effect.runPromise(profileChain(profile, env)));
}

/**
 * profileChain is the sign-in profileCredentials reads, as one Effect: the
 * profile's own way in, failing by name where the profile is not there or
 * offers none.
 * @param profile the profile to sign in as
 * @param env the environment
 * @return the credentials, kept until shortly before they expire
 */
function profileChain(
  profile: string,
  env: Env,
): Effect.Effect<Held, ChainFailure> {
  return Effect.gen(function* () {
    const files = yield* Effect.promise(() => awsFiles(env));
    const held = yield* profileSession(env, files, profile);
    if (held !== undefined) return held;
    if (
      !files.credentials.has(profile) &&
      configOf(files, profile) === undefined
    ) {
      return yield* new NoSuchProfile({ profile });
    }
    return yield* new ProfileNoWayIn({ profile });
  });
}

/**
 * awsProfiles names the profiles on this machine: every `[profile <name>]`
 * or `[default]` section of ~/.aws/config and every section of
 * ~/.aws/credentials. `default` comes first, then the rest in name order.
 * @param env the environment, process.env by default
 * @return the profile names
 */
export async function awsProfiles(env: Env = process.env): Promise<string[]> {
  const files = await awsFiles(env);
  const names = new Set<string>();
  for (const section of files.config.keys()) {
    if (section === 'default') names.add(section);
    else if (section.startsWith('profile '))
      names.add(section.slice('profile '.length).trim());
  }
  for (const section of files.credentials.keys()) names.add(section);
  const rest = [...names]
    .filter((name) => name !== 'default')
    .sort(compareStrings);
  return names.has('default') ? ['default', ...rest] : rest;
}

/**
 * ConnectionAuth signs in the way a connection says to, keeping one set of
 * credentials per way.
 */
export interface ConnectionAuth {
  /** The machine's chain: what a request outside every connection signs
   * with. */
  machine(): Promise<AwsCredentials>;
  /** How a request through `c` is signed. Refuses a mode this platform
   * lacks. */
  of(c: Connection): Promise<Signing>;
  /** The modes `of` signs with, in the order to offer them. */
  readonly modes: readonly AuthMode[];
}

/**
 * who names a connection as its signing does: its name, or its id where it has none.
 * @param c the connection
 * @return its name
 */
function who(c: Connection): string {
  return c.name === '' ? c.id : c.name;
}

/**
 * signed is `creds` in c's region where it names one, labelled with whose they are.
 * @param c the connection
 * @param creds the credentials
 * @param through whose they are, for an error
 * @return the signing
 */
function signed(
  c: Connection,
  creds: AwsCredentials,
  through: string,
): Signing {
  return {
    ...creds,
    region: c.region ?? creds.region,
    as: `${who(c)} (${through})`,
  };
}

/**
 * unsigned reads without signing in, in c's region where it names one.
 * @param c the connection
 * @param env the environment, for the region
 * @return the signing
 */
function unsigned(c: Connection, env: Env): Signing {
  return {
    unsigned: true,
    region: c.region ?? envRegion(env) ?? DEFAULT_REGION,
    as: `${who(c)} (read without signing in)`,
  };
}

/**
 * A connection that signs in with a role, on the desktop, where only uno's
 * hosted engine takes one on. The sentence says what to connect it with
 * instead.
 */
export class RoleOnDesktop extends Data.TaggedError('RoleOnDesktop')<{
  connection: string;
  roleArn: string;
  message: string;
}> {
  constructor(parts: { connection: string; roleArn: string }) {
    super({
      ...parts,
      message:
        `${parts.connection} signs in with a role, which only uno's hosted engine takes on · ` +
        `on the desktop, connect it with a profile that can assume ${parts.roleArn}`,
    });
  }
}

/**
 * connectionAuth is the desktop's ways of signing in: `machine`, `profile`
 * and `public`. `role` is refused. It is the hosted engine's.
 * @param env the environment, process.env by default
 * @return the ways of signing in
 */
export function connectionAuth(env: Env = process.env): ConnectionAuth {
  const machine = awsCredentials(env);
  const profiles = new Map<string, () => Promise<AwsCredentials>>();

  return {
    modes: ['machine', 'profile', 'public'],
    machine,
    async of(c) {
      switch (c.auth.mode) {
        case 'machine':
          return signed(c, await machine(), "this machine's AWS credentials");
        case 'profile': {
          const name = c.auth.profile;
          let read = profiles.get(name);
          if (read === undefined) {
            read = profileCredentials(name, env);
            profiles.set(name, read);
          }
          return signed(c, await read(), `the AWS profile ${name}`);
        }
        case 'public':
          return unsigned(c, env);
        case 'role':
          throw new RoleOnDesktop({
            connection: who(c),
            roleArn: c.auth.roleArn,
          });
        default:
          return unreachable(c.auth);
      }
    },
  };
}

/**
 * What a hosted engine signs in with. `base` is the engine's own credentials,
 * which the customer's role trusts. `externalId` is the condition the
 * customer's trust policy checks. It comes from the requesting tenant and
 * stays out of connection files. `principal` is what the engine signs as, for
 * writing that policy. `sessionName` is who the session is for, which is what
 * the role owner's CloudTrail shows against every read: the person, named by
 * the gate that let them in, so a read is never traced to uno and no further.
 */
export interface HostedOptions {
  base: () => Promise<AwsCredentials>;
  externalId: string;
  principal: string;
  sessionName: string;
  env?: Env;
  /** Where STS is, for a test stand-in. Otherwise AWS_ENDPOINT_URL_STS. */
  stsEndpoint?: string;
}

/**
 * An address no connection covers, on the hosted engine, which has no
 * machine of its own to sign with.
 */
export class OutsideEveryConnection extends Data.TaggedError(
  'OutsideEveryConnection',
)<{ message: string }> {
  constructor() {
    super({
      message:
        "uno's hosted engine reads only the buckets a connection covers · " +
        'it signs in with a role in your account, not with a machine of its own',
    });
  }
}

/**
 * A connection that signs in as a machine or a profile, on the hosted
 * engine, which is no machine of anyone's. The sentence says what to connect
 * it with instead.
 */
export class MachineOnHosted extends Data.TaggedError('MachineOnHosted')<{
  connection: string;
  message: string;
}> {
  constructor(parts: { connection: string }) {
    super({
      ...parts,
      message:
        `${parts.connection} signs in as a machine of its own, which uno's hosted engine is not · ` +
        'connect it with a role in your account that uno may assume',
    });
  }
}

/**
 * hostedAuth is the hosted engine's ways of signing in: `role` and `public`.
 * A `role` connection is assumed through STS with the tenant's external ID,
 * as a session named for the person, and its keys are kept until shortly
 * before they expire. The keys are kept per role, in this process, and a
 * process is one workspace's, so no session is ever shared across tenants. `machine` and
 * `profile` are refused, and `machine()` rejects, so only an address a
 * connection covers is read.
 * @param opts what the engine signs in with
 * @return the ways of signing in
 */
export function hostedAuth(opts: HostedOptions): ConnectionAuth {
  const env = opts.env ?? process.env;
  const roles = new Map<string, () => Promise<AwsCredentials>>();
  return {
    modes: ['role', 'public'],
    machine() {
      return Promise.reject(new OutsideEveryConnection());
    },
    async of(c) {
      switch (c.auth.mode) {
        case 'role': {
          const roleArn = c.auth.roleArn;
          let read = roles.get(roleArn);
          if (read === undefined) {
            read = cached(async () => {
              const source = await opts.base();
              const region = c.region ?? source.region;
              const session = await assumeRole(
                {
                  roleArn,
                  sessionName: opts.sessionName,
                  externalId: opts.externalId,
                  region,
                },
                source,
                { endpoint: opts.stsEndpoint ?? env['AWS_ENDPOINT_URL_STS'] },
              );
              return {
                creds: { ...session, region },
                until: session.expiration.getTime() - EARLY_MS,
              };
            });
            roles.set(roleArn, read);
          }
          return signed(c, await read(), 'a role in your account');
        }
        case 'public':
          return unsigned(c, env);
        case 'machine':
        case 'profile':
          throw new MachineOnHosted({ connection: who(c) });
        default:
          return unreachable(c.auth);
      }
    },
  };
}

/**
 * connectionSigning signs each request with the connection that covers its
 * location, or with the machine's chain where none does. `connections` is
 * called on every request, so a connection saved while the engine runs is
 * used by the next request.
 * @param connections the connections saved, read on every request
 * @param env the environment, process.env by default
 * @param auth the ways of signing in, the desktop's by default
 * @return the signer for a location
 */
export function connectionSigning(
  connections: () => readonly Connection[],
  env: Env = process.env,
  auth: ConnectionAuth = connectionAuth(env),
): (loc: S3Location) => Promise<Signing> {
  return (loc) => {
    const c = covering(connections(), loc.bucket, loc.key);
    return c === undefined ? auth.machine() : auth.of(c);
  };
}

/**
 * readText is a file's text, or undefined for a missing file.
 * @param path the file
 * @return its text, or undefined
 */
async function readText(path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(
      await readAll([localFiles()], { name: basename(path), path }),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * ini reads an AWS-style ini file into sections of keys. A missing file is
 * empty.
 * @param path the file
 * @return its sections of keys
 */
async function ini(path: string): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const text = await readText(path);
  if (text === undefined) return out;
  let section: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head !== null) {
      section = new Map();
      out.set(head[1]!.trim(), section);
      continue;
    }
    const eq = line.indexOf('=');
    if (section === undefined || eq < 0) continue;
    section.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}
