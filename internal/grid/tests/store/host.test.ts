/**
 * @fileoverview The end of the credential chain, where a host says who it is:
 * a web identity token the environment or a profile names, traded at STS
 * for a role.
 *
 * The stand-in STS trades a token a role's trust names. The token is reached
 * for only after the environment's keys and the profile.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vite-plus/test';

import { awsCredentials, profileCredentials } from '@store/node';
import { HOME_REGION } from './regions.ts';
import { sts } from './stsstandin.ts';
import type { Sts } from './stsstandin.ts';

/** What the web identity role hands out. */
const POD = {
  accessKeyId: 'ASIDPOD',
  secretAccessKey: 'pod/secret',
  sessionToken: 'pod-token',
};
const POD_ROLE = 'arn:aws:iam::210987654321:role/uno-pod';
const POD_TOKEN = 'eyJ.pod.identity';

let s: Sts;
beforeAll(async () => {
  s = await sts(
    [],
    new Map([[POD_ROLE, { callers: [], tokens: [POD_TOKEN], session: POD }]]),
  );
});
afterAll(() => s.close());
beforeEach(() => {
  s.seen.length = 0;
});

/**
 * machine is an environment with an empty ~/.aws and the stand-in STS.
 * `config` is ~/.aws/config.
 */
async function machine(
  extra: Record<string, string | undefined> = {},
  config = '',
): Promise<Record<string, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), 'uno-host-'));
  await writeFile(join(dir, 'config'), config);
  await writeFile(join(dir, 'credentials'), '');
  return {
    HOME: dir,
    AWS_CONFIG_FILE: join(dir, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials'),
    AWS_REGION: HOME_REGION,
    AWS_PROFILE: undefined,
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_SESSION_TOKEN: undefined,
    AWS_ENDPOINT_URL_STS: s.endpoint,
    AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
    AWS_ROLE_ARN: undefined,
    AWS_ROLE_SESSION_NAME: undefined,
    ...extra,
  };
}

/** A file holding `text`, in a folder of its own. */
async function file(name: string, text: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'uno-host-file-')), name);
  await writeFile(path, text);
  return path;
}

describe('a web identity token', () => {
  test('the environment names is traded at STS for the role, unsigned', async () => {
    const env = await machine({
      AWS_WEB_IDENTITY_TOKEN_FILE: await file('token', `${POD_TOKEN}\n`),
      AWS_ROLE_ARN: POD_ROLE,
      AWS_ROLE_SESSION_NAME: 'pod-7',
    });
    expect(await awsCredentials(env)()).toEqual({
      ...POD,
      region: HOME_REGION,
    });
    expect(s.seen).toEqual([
      {
        caller: POD_TOKEN,
        roleArn: POD_ROLE,
        externalId: undefined,
        sessionName: 'pod-7',
        region: '',
      },
    ]);
  });

  test('a profile names with web_identity_token_file', async () => {
    const token = await file('token', POD_TOKEN);
    const env = await machine(
      {},
      `[profile pod]\nrole_arn = ${POD_ROLE}\nweb_identity_token_file = ${token}\nrole_session_name = ana\nregion = ${HOME_REGION}\n`,
    );
    expect(await profileCredentials('pod', env)()).toEqual({
      ...POD,
      region: HOME_REGION,
      as: 'the AWS profile pod',
    });
    expect(s.seen.map((r) => r.sessionName)).toEqual(['ana']);
  });

  test('a token file that is not there is said by name', async () => {
    const env = await machine({
      AWS_WEB_IDENTITY_TOKEN_FILE: '/nowhere/token',
      AWS_ROLE_ARN: POD_ROLE,
    });
    await expect(awsCredentials(env)()).rejects.toThrow(
      'the environment names the web identity token file /nowhere/token, which is not there',
    );
    expect(s.seen).toEqual([]);
  });

  test('the role does not trust is refused with what STS said', async () => {
    const env = await machine({
      AWS_WEB_IDENTITY_TOKEN_FILE: await file('token', 'somebody-elses'),
      AWS_ROLE_ARN: POD_ROLE,
    });
    await expect(awsCredentials(env)()).rejects.toThrow(
      `STS would not let ${POD_ROLE} be assumed · AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity on resource: ${POD_ROLE}`,
    );
  });
});

describe('the chain', () => {
  test('a profile with keys comes before the token', async () => {
    const env = await machine(
      {
        AWS_WEB_IDENTITY_TOKEN_FILE: '/nowhere/token',
        AWS_ROLE_ARN: POD_ROLE,
      },
      '[default]\naws_access_key_id = AKIDFILE\naws_secret_access_key = file/secret\n',
    );
    expect((await awsCredentials(env)()).accessKeyId).toBe('AKIDFILE');
    expect(s.seen).toEqual([]);
  });

  test('keys in the environment come before everything', async () => {
    const env = await machine({
      AWS_ACCESS_KEY_ID: 'AKIDENV',
      AWS_SECRET_ACCESS_KEY: 'env/secret',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/nowhere/token',
      AWS_ROLE_ARN: POD_ROLE,
    });
    expect((await awsCredentials(env)()).accessKeyId).toBe('AKIDENV');
    expect(s.seen).toEqual([]);
  });
});
