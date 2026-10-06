/**
 * @fileoverview The end of the credential chain, where a host says who it is:
 * a web identity token the environment or a profile names, the endpoint
 * beside a container, and the instance metadata service.
 *
 * The stand-in host answers IMDSv2 and v1 and a container path. The stand-in
 * STS trades a web identity token for a role. Each is reached only in its
 * turn, and a bucket is read with what the instance's role was handed.
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

import { containerCredentials, instanceCredentials } from '@store/metadata';
import {
  awsCredentials,
  connectionSigning,
  diskProvider,
  profileCredentials,
} from '@store/node';
import { s3Provider } from '@store/s3';
import { bytes, connect, indexed, openOne } from '@core-tests/engine/harness';
import { ROWS } from '@core-tests/testdata/sales-q3';
import { host } from './host.ts';
import type { Host } from './host.ts';
import { HOME_REGION } from './regions.ts';
import { bucket } from './standin.ts';
import type { Bucket } from './standin.ts';
import { sts } from './stsstandin.ts';
import type { Sts } from './stsstandin.ts';

/** What the instance's role, the task's role and the web identity role hand out. */
const INSTANCE = {
  accessKeyId: 'ASIDINSTANCE',
  secretAccessKey: 'instance/secret',
  sessionToken: 'instance-token',
};
const TASK = {
  accessKeyId: 'ASIDTASK',
  secretAccessKey: 'task/secret',
  sessionToken: 'task-token',
};
const POD = {
  accessKeyId: 'ASIDPOD',
  secretAccessKey: 'pod/secret',
  sessionToken: 'pod-token',
};
const READER_SESSION = {
  accessKeyId: 'ASIDREADER',
  secretAccessKey: 'reader/secret',
  sessionToken: 'reader-token',
};
const READER = 'arn:aws:iam::210987654321:role/uno-read';
const POD_ROLE = 'arn:aws:iam::210987654321:role/uno-pod';
const POD_TOKEN = 'eyJ.pod.identity';

let h: Host;
let s: Sts;
let b: Bucket;
beforeAll(async () => {
  h = await host();
  s = await sts(
    [INSTANCE, TASK],
    new Map([
      [
        READER,
        {
          callers: [INSTANCE.accessKeyId, TASK.accessKeyId],
          session: READER_SESSION,
        },
      ],
      [POD_ROLE, { callers: [], tokens: [POD_TOKEN], session: POD }],
    ]),
  );
  b = await bucket(undefined, HOME_REGION, undefined, {
    'acme-finance-lake': {
      objects: new Map([['exports/ledger.csv', bytes]]),
      keys: { ...INSTANCE, region: HOME_REGION },
    },
  });
});
afterAll(async () => {
  await h.close();
  await s.close();
  await b.close();
});
beforeEach(() => {
  h.role = { name: 'uno-instance', keys: INSTANCE };
  h.v2 = true;
  h.container = undefined;
  h.seen.length = 0;
  s.seen.length = 0;
});

/**
 * machine is an environment with an empty ~/.aws and the stand-ins as the
 * host's endpoints. `config` is ~/.aws/config.
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
    AWS_EC2_METADATA_SERVICE_ENDPOINT: h.endpoint,
    AWS_EC2_METADATA_DISABLED: undefined,
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
    AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
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

/** The paths the host was asked for, in order. */
const asked = (): string[] => h.seen.map((r) => `${r.method} ${r.path}`);

const ROLES = '/latest/meta-data/iam/security-credentials/';

describe('the instance metadata service', () => {
  test("hands out the role's keys over IMDSv2, which sign a read of a bucket", async () => {
    const env = await machine();
    expect(await awsCredentials(env)()).toEqual({
      ...INSTANCE,
      region: HOME_REGION,
    });
    expect(asked()).toEqual([
      'PUT /latest/api/token',
      `GET ${ROLES}`,
      `GET ${ROLES}uno-instance`,
    ]);
    // Every read after the token carried it.
    expect(h.seen.slice(1).map((r) => r.token)).toEqual([
      'imds-token',
      'imds-token',
    ]);

    const s3 = s3Provider({
      credentials: connectionSigning(() => [], env),
      endpoint: b.endpoint,
    });
    const { engine, done } = connect(undefined, [diskProvider(), s3]);
    try {
      const ledger = await openOne(engine, {
        name: 'ledger.csv',
        path: 's3://acme-finance-lake/exports/ledger.csv',
      });
      await indexed(ledger);
      expect(ledger.progress.rows).toBe(ROWS);
    } finally {
      done();
    }
  });

  test('is asked the v1 way when it turns the token request away', async () => {
    h.v2 = false;
    expect((await awsCredentials(await machine())()).accessKeyId).toBe(
      INSTANCE.accessKeyId,
    );
    expect(asked()).toEqual([
      'PUT /latest/api/token',
      `GET ${ROLES}`,
      `GET ${ROLES}uno-instance`,
    ]);
    expect(h.seen.slice(1).map((r) => r.token)).toEqual([undefined, undefined]);
  });

  test('is asked once, and the keys reused until they near expiry', async () => {
    const creds = awsCredentials(await machine());
    for (let i = 0; i < 3; i++) await creds();
    expect(h.seen).toHaveLength(3);
  });

  test('an instance with no role is no credentials', async () => {
    h.role = undefined;
    await expect(awsCredentials(await machine())()).rejects.toThrow(
      /^no AWS credentials · set .* or run uno where a role is attached$/,
    );
    expect(asked()).toEqual(['PUT /latest/api/token', `GET ${ROLES}`]);
  });

  // A host that answers the token request and then drops the connection is
  // not an instance either.
  test('answering the token and then nothing is no credentials', async () => {
    const fetch: typeof globalThis.fetch = (_, init) =>
      init?.method === 'PUT'
        ? Promise.resolve(new Response('', { status: 403 }))
        : Promise.reject(new TypeError('fetch failed'));
    expect(
      await instanceCredentials('http://169.254.169.254', { fetch }),
    ).toBeUndefined();
  });

  test('is left alone when AWS_EC2_METADATA_DISABLED is true', async () => {
    await expect(
      awsCredentials(await machine({ AWS_EC2_METADATA_DISABLED: 'true' }))(),
    ).rejects.toThrow(/^no AWS credentials/);
    expect(h.seen).toEqual([]);
  });

  test('nothing answering at its address is no credentials', async () => {
    const env = await machine({
      AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://127.0.0.1:1',
    });
    await expect(awsCredentials(env)()).rejects.toThrow(/^no AWS credentials/);
  });

  test('is the source of a profile whose credential_source is Ec2InstanceMetadata', async () => {
    const env = await machine(
      {},
      `[profile from-instance]\nrole_arn = ${READER}\ncredential_source = Ec2InstanceMetadata\nregion = ${HOME_REGION}\n`,
    );
    expect(await profileCredentials('from-instance', env)()).toEqual({
      ...READER_SESSION,
      region: HOME_REGION,
      as: 'the AWS profile from-instance',
    });
    expect(s.seen.map((r) => [r.caller, r.roleArn])).toEqual([
      [INSTANCE.accessKeyId, READER],
    ]);
  });
});

describe('the container endpoint', () => {
  const PATH = '/v2/credentials/7f3c';

  test("hands out the task's keys, with the token the environment holds", async () => {
    h.container = { path: PATH, keys: TASK, token: 'task-auth' };
    const env = await machine({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: h.endpoint + PATH,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'task-auth',
    });
    expect(await awsCredentials(env)()).toEqual({
      ...TASK,
      region: HOME_REGION,
    });
    expect(h.seen).toEqual([
      {
        method: 'GET',
        path: PATH,
        token: undefined,
        authorization: 'task-auth',
      },
    ]);
  });

  test('reads its token from the file the environment names', async () => {
    h.container = { path: PATH, keys: TASK, token: 'from-file' };
    const env = await machine({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: h.endpoint + PATH,
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: await file(
        'token',
        'from-file\n',
      ),
    });
    expect((await awsCredentials(env)()).accessKeyId).toBe(TASK.accessKeyId);
    expect(h.seen[0]?.authorization).toBe('from-file');
  });

  test('comes before the instance metadata service', async () => {
    h.container = { path: PATH, keys: TASK };
    const env = await machine({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: h.endpoint + PATH,
    });
    expect((await awsCredentials(env)()).accessKeyId).toBe(TASK.accessKeyId);
    expect(asked()).toEqual([`GET ${PATH}`]);
  });

  test('the wrong token is refused with what the endpoint answered', async () => {
    h.container = { path: PATH, keys: TASK, token: 'task-auth' };
    const env = await machine({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: h.endpoint + PATH,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'not it',
    });
    await expect(awsCredentials(env)()).rejects.toThrow(
      `the container endpoint ${h.endpoint}${PATH} answered 401`,
    );
  });

  test('a token file that is not there is said by name', async () => {
    const env = await machine({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: h.endpoint + PATH,
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/nowhere/token',
    });
    await expect(awsCredentials(env)()).rejects.toThrow(
      'the environment names the container token file /nowhere/token, which is not there',
    );
    expect(h.seen).toEqual([]);
  });

  // A token is sent only over https or to this host, so a URL elsewhere is
  // refused before any request goes out.
  test.each([
    'http://example.com/creds',
    'http://10.0.0.5/creds',
    'ftp://localhost/creds',
  ])('%s is refused before anything is sent', async (url) => {
    await expect(containerCredentials(url, 'secret')).rejects.toThrow(
      `the container endpoint ${url} is neither https nor on this host`,
    );
  });

  test('is the source of a profile whose credential_source is EcsContainer', async () => {
    h.container = { path: PATH, keys: TASK };
    const env = await machine(
      { AWS_CONTAINER_CREDENTIALS_FULL_URI: h.endpoint + PATH },
      `[profile from-task]\nrole_arn = ${READER}\ncredential_source = EcsContainer\nregion = ${HOME_REGION}\n`,
    );
    expect((await profileCredentials('from-task', env)()).accessKeyId).toBe(
      READER_SESSION.accessKeyId,
    );
    expect(s.seen.map((r) => r.caller)).toEqual([TASK.accessKeyId]);
  });

  test('a profile whose source is a container, off one, is said by name', async () => {
    const env = await machine(
      {},
      `[profile from-task]\nrole_arn = ${READER}\ncredential_source = EcsContainer\n`,
    );
    await expect(profileCredentials('from-task', env)()).rejects.toThrow(
      'the AWS profile from-task takes its credentials from its container, and the environment names no container endpoint',
    );
  });
});

describe('a web identity token', () => {
  test('the environment names is traded at STS for the role, unsigned, before the host is asked', async () => {
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
    expect(h.seen).toEqual([]);
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
  test('a profile with keys comes before the host', async () => {
    const env = await machine(
      {},
      '[default]\naws_access_key_id = AKIDFILE\naws_secret_access_key = file/secret\n',
    );
    expect((await awsCredentials(env)()).accessKeyId).toBe('AKIDFILE');
    expect(h.seen).toEqual([]);
  });

  test('keys in the environment come before everything', async () => {
    const env = await machine({
      AWS_ACCESS_KEY_ID: 'AKIDENV',
      AWS_SECRET_ACCESS_KEY: 'env/secret',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/nowhere/token',
      AWS_ROLE_ARN: POD_ROLE,
    });
    expect((await awsCredentials(env)()).accessKeyId).toBe('AKIDENV');
    expect(h.seen).toEqual([]);
    expect(s.seen).toEqual([]);
  });
});
