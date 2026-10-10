// STS AssumeRole: the call itself, and the profiles that make it.
//
// The stand-in STS checks the signature and the external ID. The profiles
// cover role_arn with source_profile, a chain of roles, and
// credential_source = Environment.

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

/** The keys that may assume the reader role only. */
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

  // The right ARN with the wrong external ID is refused with STS's message.
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

  // RoleSessionName must be 2 to 64 of [\w+=,.@-]. Other names are refused
  // before any request is sent.
  test.each([
    ["a", "a"],
    ["x".repeat(65), "x".repeat(65)],
    ["ana at acme", "ana at acme"],
    ["ana/acme", "ana/acme"],
  ])("a session name STS would not take is refused before it is sent: %s", async (_, name) => {
    await expect(
      assumeRole(
        { roleArn: READER, sessionName: name, externalId: EXTERNAL, region: HOME_REGION },
        BASE,
        { endpoint: s.endpoint },
      ),
    ).rejects.toThrow(
      `${READER} cannot be assumed as "${name}" · a role session name is 2 to 64 of letters, digits and +=,.@_-`,
    );
    expect(s.seen).toEqual([]);
  });

  test("a session name of every character STS takes goes through", async () => {
    const name = "Ana+at=acme,Inc.@2025_x-y";
    await assumeRole(
      { roleArn: READER, sessionName: name, externalId: EXTERNAL, region: HOME_REGION },
      BASE,
      { endpoint: s.endpoint },
    );
    expect(s.seen.map((r) => r.sessionName)).toEqual([name]);
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

  // Entities in the STS message are decoded. A numeric escape past the
  // Unicode range is left as written.
  test("a refusal escaped past what a string can hold is still said in words", async () => {
    const message = "Session for a&amp;b was refused at &#1114112; by &#xFFFFFFFF;";
    const refuse: typeof fetch = async () =>
      new Response(
        `<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code>` +
          `<Message>${message}</Message></Error></ErrorResponse>`,
        { status: 403, headers: { "content-type": "text/xml" } },
      );
    await expect(
      assumeRole(
        { roleArn: READER, sessionName: "ana", externalId: EXTERNAL, region: HOME_REGION },
        BASE,
        { endpoint: s.endpoint, fetch: refuse },
      ),
    ).rejects.toThrow(
      `STS would not let ${READER} be assumed · AccessDenied: Session for a&b was refused at &#1114112; by &#xFFFFFFFF;`,
    );
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
