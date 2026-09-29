// The hosted engine's way of signing in: a role in the customer's account,
// taken on with the account's external ID, and nothing of the machine it runs
// on.
//
// What is under test is the gate the whole hosted model rests on. A `role`
// connection is assumed through STS -- the stand-in checks the signature and
// the external ID the way STS does, so a session out of it proves both. An
// address no connection covers, and a connection that names this machine, are
// refused, so a .uno somebody sent cannot make the instance read a bucket with
// its own role.

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import type { Connection } from "../../src/library/index.ts";
import { hostedAuth } from "../../src/store/node.ts";
import type { AwsCredentials, S3Location } from "../../src/store/s3.ts";
import { HOME_REGION } from "./regions.ts";
import { sts } from "./stsstandin.ts";
import type { Sts } from "./stsstandin.ts";

/** The instance's own keys: the role its EC2 instance runs as. */
const INSTANCE: AwsCredentials = {
  accessKeyId: "AKIDINSTANCE",
  secretAccessKey: "instance/secret",
  region: HOME_REGION,
};
const PRINCIPAL = "arn:aws:iam::111122223333:role/uno-engine";
const EXTERNAL = "acme-7f3c9a21e04b";
const CUSTOMER = "arn:aws:iam::210987654321:role/uno-read";
const SESSION = {
  accessKeyId: "ASIDCUSTOMER",
  secretAccessKey: "customer/secret",
  sessionToken: "customer-token",
};

let s: Sts;
beforeAll(async () => {
  s = await sts(
    [INSTANCE],
    new Map([[CUSTOMER, { callers: [INSTANCE.accessKeyId], externalId: EXTERNAL, session: SESSION }]]),
  );
});
afterAll(() => s.close());

function auth() {
  return hostedAuth({
    base: () => Promise.resolve(INSTANCE),
    externalId: EXTERNAL,
    principal: PRINCIPAL,
    stsEndpoint: s.endpoint,
    env: {},
  });
}

function connection(auth: Connection["auth"], over: Partial<Connection> = {}): Connection {
  return {
    format: 1,
    id: "lake",
    name: "acme lake",
    provider: "s3",
    bucket: "acme-finance-lake",
    prefix: "",
    region: HOME_REGION,
    auth,
    created: undefined,
    modified: undefined,
    ...over,
  };
}

const LOC: S3Location = { bucket: "acme-finance-lake", key: "exports/ledger.csv" };

test("a role connection is the session STS hands out, signed for the bucket's region", async () => {
  const signing = await auth().of(connection({ mode: "role", roleArn: CUSTOMER }));
  expect(signing).toMatchObject({ ...SESSION, region: HOME_REGION });
  expect(s.seen).toEqual([
    {
      caller: INSTANCE.accessKeyId,
      roleArn: CUSTOMER,
      externalId: EXTERNAL,
      sessionName: expect.stringMatching(/^uno-\d+$/),
      region: HOME_REGION,
    },
  ]);
});

test("the session is kept, so a second request does not assume the role again", async () => {
  const a = auth();
  await a.of(connection({ mode: "role", roleArn: CUSTOMER }));
  s.seen.length = 0;
  await a.of(connection({ mode: "role", roleArn: CUSTOMER }));
  expect(s.seen).toEqual([]);
});

test("a role the account does not let this engine assume is refused, with what STS said", async () => {
  const other = "arn:aws:iam::210987654321:role/not-ours";
  await expect(auth().of(connection({ mode: "role", roleArn: other }))).rejects.toThrow(
    /STS would not let .* be assumed · AccessDenied/,
  );
});

test("a public bucket is read unsigned", async () => {
  const signing = await auth().of(connection({ mode: "public" }, { region: "us-east-1" }));
  expect(signing).toEqual({
    unsigned: true,
    region: "us-east-1",
    as: "acme lake (read without signing in)",
  });
});

// The confused-deputy guard: nothing the engine holds reads a bucket a
// connection does not cover, and a connection that names a machine is refused.
test("an address no connection covers signs with no machine the engine has", async () => {
  await expect(auth().machine()).rejects.toThrow(
    "uno's hosted engine reads only the buckets a connection covers",
  );
});

test.each([
  ["machine", { mode: "machine" } as const],
  ["profile", { mode: "profile", profile: "finance" } as const],
])("a %s connection is refused by name on the hosted engine", async (_, mode) => {
  await expect(auth().of(connection(mode))).rejects.toThrow(
    /signs in as a machine of its own, which uno's hosted engine is not/,
  );
  void LOC;
});
