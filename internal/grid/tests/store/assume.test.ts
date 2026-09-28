// STS AssumeRole: a role taken on with credentials its trust policy names.
//
// What is under test is the call and the profiles that make it. The stand-in
// checks the signature and the external ID the way STS does, so a session
// coming back out of it proves both were right. The profiles are the ways a
// company hands out a role: role_arn beside a source_profile, a chain of them,
// and credential_source = Environment.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { connectionSigning, diskProvider, profileCredentials } from "../../src/store/node.ts";
import { s3Provider } from "../../src/store/s3.ts";
import { assumeRole } from "../../src/store/sts.ts";
import { bytes, connect, indexed, openOne } from "../engine/harness.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { HOME_REGION } from "./regions.ts";
import { bucket } from "./standin.ts";
import type { Bucket } from "./standin.ts";
import { sts } from "./stsstandin.ts";
import type { Sts } from "./stsstandin.ts";

/** The keys a person holds, which may assume the reader role and nothing else. */
const BASE = { accessKeyId: "AKIDBASE", secretAccessKey: "base/secret" };
const READER = "arn:aws:iam::210987654321:role/uno-read";
const AUDITOR = "arn:aws:iam::210987654321:role/uno-audit";
const EXTERNAL = "uno-t-7f3c9a21e04b";

/** What each role hands out. The reader's session may itself assume the auditor. */
const READER_SESSION = {
  accessKeyId: "ASIDREADER",
  secretAccessKey: "reader/secret",
  sessionToken: "reader-token",
};
const AUDITOR_SESSION = {
  accessKeyId: "ASIDAUDITOR",
  secretAccessKey: "auditor/secret",
  sessionToken: "auditor-token",
};

let s: Sts;
let b: Bucket;
beforeAll(async () => {
  s = await sts(
    [BASE, READER_SESSION],
    new Map([
      [READER, { callers: [BASE.accessKeyId], externalId: EXTERNAL, session: READER_SESSION }],
      [AUDITOR, { callers: [READER_SESSION.accessKeyId], session: AUDITOR_SESSION }],
    ]),
  );
  b = await bucket(undefined, HOME_REGION, undefined, {
    "acme-finance-lake": {
      objects: new Map([["exports/ledger.csv", bytes]]),
      keys: { ...READER_SESSION, region: HOME_REGION },
    },
  });
});
afterAll(async () => {
  await s.close();
  await b.close();
});
beforeEach(() => {
  s.seen.length = 0;
});

const CONFIG = `
[profile base]
region = ${HOME_REGION}

[profile reader]
role_arn = ${READER}
source_profile = base
external_id = ${EXTERNAL}
role_session_name = ana-at-acme
region = ${HOME_REGION}

[profile auditor]
role_arn = ${AUDITOR}
source_profile = reader
region = ${HOME_REGION}

[profile wrong-id]
role_arn = ${READER}
source_profile = base
external_id = somebody-elses
region = ${HOME_REGION}

[profile from-env]
role_arn = ${READER}
credential_source = Environment
external_id = ${EXTERNAL}
region = ${HOME_REGION}

[profile loop-a]
role_arn = ${READER}
source_profile = loop-b

[profile loop-b]
role_arn = ${AUDITOR}
source_profile = loop-a

[profile with-mfa]
role_arn = ${READER}
source_profile = base
mfa_serial = arn:aws:iam::210987654321:mfa/ana

[profile from-metadata]
role_arn = ${READER}
credential_source = Ec2InstanceMetadata
`;

async function machine(extra: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "uno-assume-"));
  await writeFile(join(dir, "config"), CONFIG);
  await writeFile(
    join(dir, "credentials"),
    `[base]\naws_access_key_id = ${BASE.accessKeyId}\naws_secret_access_key = ${BASE.secretAccessKey}\n`,
  );
  return {
    HOME: dir,
    AWS_CONFIG_FILE: join(dir, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
    AWS_ENDPOINT_URL_STS: s.endpoint,
    AWS_REGION: undefined,
    AWS_PROFILE: undefined,
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_SESSION_TOKEN: undefined,
    ...extra,
  };
}

describe("the call", () => {
  // The task's own sentence.
  test("a stand-in STS that checks the signature and the external ID hands out a session", async () => {
    const session = await assumeRole(
      { roleArn: READER, sessionName: "ana", externalId: EXTERNAL, region: HOME_REGION },
      BASE,
      { endpoint: s.endpoint },
    );
    expect(session).toMatchObject(READER_SESSION);
    expect(session.expiration.getTime()).toBeGreaterThan(Date.now());
    expect(s.seen).toEqual([
      {
        caller: BASE.accessKeyId,
        roleArn: READER,
        externalId: EXTERNAL,
        sessionName: "ana",
        region: HOME_REGION,
      },
    ]);
  });

  // The confused-deputy guard the hosted engine rests on: the right ARN with
  // somebody else's external ID is refused, and says why.
  test("the wrong external ID is refused, with what STS said", async () => {
    await expect(
      assumeRole(
        { roleArn: READER, sessionName: "ana", externalId: "not-ours", region: HOME_REGION },
        BASE,
        {
          endpoint: s.endpoint,
        },
      ),
    ).rejects.toThrow(
      `STS would not let ${READER} be assumed · AccessDenied: User: ${BASE.accessKeyId} is not authorized to perform: sts:AssumeRole on resource: ${READER}`,
    );
  });

  test("a signature taken with the wrong secret is refused", async () => {
    await expect(
      assumeRole(
        { roleArn: READER, sessionName: "ana", externalId: EXTERNAL, region: HOME_REGION },
        { ...BASE, secretAccessKey: "not it" },
        { endpoint: s.endpoint },
      ),
    ).rejects.toThrow(/· SignatureDoesNotMatch:/);
  });
});

describe("profiles with role_arn", () => {
  test("take on the role with source_profile's keys, and the external ID the profile names", async () => {
    const env = await machine();
    expect(await profileCredentials("reader", env)()).toEqual({
      ...READER_SESSION,
      region: HOME_REGION,
      as: "the AWS profile reader",
    });
    expect(s.seen).toEqual([
      {
        caller: BASE.accessKeyId,
        roleArn: READER,
        externalId: EXTERNAL,
        sessionName: "ana-at-acme",
        region: HOME_REGION,
      },
    ]);
  });

  test("reuse the session rather than asking STS per request", async () => {
    const creds = profileCredentials("reader", await machine());
    for (let i = 0; i < 3; i++) await creds();
    expect(s.seen).toHaveLength(1);
  });

  // A role whose source is a role: the first session assumes the second.
  test("follow a chain of roles, one AssumeRole each, in order", async () => {
    expect((await profileCredentials("auditor", await machine())()).accessKeyId).toBe(
      AUDITOR_SESSION.accessKeyId,
    );
    expect(s.seen.map((r) => [r.caller, r.roleArn])).toEqual([
      [BASE.accessKeyId, READER],
      [READER_SESSION.accessKeyId, AUDITOR],
    ]);
  });

  test("take the source from the environment when credential_source says so", async () => {
    const env = await machine({
      AWS_ACCESS_KEY_ID: BASE.accessKeyId,
      AWS_SECRET_ACCESS_KEY: BASE.secretAccessKey,
    });
    expect((await profileCredentials("from-env", env)()).accessKeyId).toBe(
      READER_SESSION.accessKeyId,
    );
  });

  test("read a bucket through a connection, with the session's keys", async () => {
    const env = await machine();
    const lake = {
      format: 1,
      id: "finance-lake",
      name: "Finance lake",
      provider: "s3" as const,
      bucket: "acme-finance-lake",
      prefix: "exports/",
      auth: { mode: "profile" as const, profile: "reader" },
      created: undefined,
      modified: undefined,
    };
    const s3 = s3Provider({
      credentials: connectionSigning(() => [lake], env),
      endpoint: b.endpoint,
    });
    const { engine, done } = connect(undefined, [diskProvider(), s3]);
    try {
      const ledger = await openOne(engine, {
        name: "ledger.csv",
        path: "s3://acme-finance-lake/exports/ledger.csv",
      });
      await indexed(ledger);
      expect(ledger.progress.rows).toBe(ROWS);
      expect(s.seen).toHaveLength(1);
    } finally {
      done();
    }
  });
});

describe("what a role profile cannot do is said by name", () => {
  test("an external ID the trust does not ask for", async () => {
    await expect(profileCredentials("wrong-id", await machine())()).rejects.toThrow(
      /· AccessDenied:/,
    );
  });

  test("a chain that comes back on itself", async () => {
    await expect(profileCredentials("loop-a", await machine())()).rejects.toThrow(
      "the AWS profile loop-b takes its credentials from a loop · loop-a → loop-b → loop-a",
    );
    expect(s.seen).toEqual([]);
  });

  test("an MFA code nobody is there to type", async () => {
    await expect(profileCredentials("with-mfa", await machine())()).rejects.toThrow(
      `the AWS profile with-mfa asks for an MFA code to assume ${READER}, which uno cannot ask for`,
    );
  });

  test("a credential_source uno does not reach", async () => {
    await expect(profileCredentials("from-metadata", await machine())()).rejects.toThrow(
      "the AWS profile from-metadata takes its credentials from Ec2InstanceMetadata, which uno does not reach · use source_profile or Environment",
    );
  });
});
