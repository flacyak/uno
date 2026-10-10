// awsProfiles: the profile names the engine offers for signing in.
//
// The reply holds names only. It is taken off the engine channel and
// searched for every secret the ~/.aws files hold.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

import { messagePort, serve } from "../../src/engine/index.ts";
import type { MessagePortLike, Reply, Request } from "../../src/engine/index.ts";
import { sources } from "../../src/plugin/index.ts";
import { connectionsIn } from "../../src/store/index.ts";
import { awsProfiles, diskProvider, nodeStore } from "../../src/store/node.ts";
import { connect } from "../engine/harness.ts";

/** Everything in the files below besides the profile names. */
const SECRETS = [
  "AKIAIOSFODNN7EXAMPLE",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "FwoGZXIvYXdzEXAMPLESESSIONTOKEN",
  "AKIDFINANCEEXAMPLE",
  "finance/secret/EXAMPLE",
  "arn:aws:iam::210987654321:role/uno-read",
  "https://acme.awsapps.com/start",
  "111122223333",
  "vault exec finance",
];

async function machine(): Promise<Record<string, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), "uno-profiles-"));
  await writeFile(
    join(dir, "config"),
    [
      "[default]",
      "region = eu-west-1",
      "[profile reader]",
      "role_arn = arn:aws:iam::210987654321:role/uno-read",
      "source_profile = finance",
      "[profile sso-work]",
      "sso_session = acme",
      "sso_account_id = 111122223333",
      "sso_role_name = Read",
      "[sso-session acme]",
      "sso_start_url = https://acme.awsapps.com/start",
      "[profile vault]",
      "credential_process = vault exec finance",
      "[services local-s3]",
      "s3 =",
      "  endpoint_url = http://localhost:9000",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "credentials"),
    [
      "[default]",
      "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "aws_session_token = FwoGZXIvYXdzEXAMPLESESSIONTOKEN",
      "[finance]",
      "aws_access_key_id = AKIDFINANCEEXAMPLE",
      "aws_secret_access_key = finance/secret/EXAMPLE",
      "",
    ].join("\n"),
  );
  return {
    HOME: dir,
    AWS_CONFIG_FILE: join(dir, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
  };
}

test("every profile in both files is named once, default first", async () => {
  expect(await awsProfiles(await machine())).toEqual([
    "default",
    "finance",
    "reader",
    "sso-work",
    "vault",
  ]);
});

test("a machine with no ~/.aws has no profiles rather than a failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-profiles-none-"));
  expect(await awsProfiles({ HOME: dir })).toEqual([]);
});

test("the engine's reply holds names only, and no key reaches it", async () => {
  const env = await machine();
  const dir = await mkdtemp(join(tmpdir(), "uno-profiles-connections-"));
  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
    sources([diskProvider()]),
    undefined,
    {
      connections: connectionsIn(nodeStore(), dir),
      signIns: async () => ({
        modes: ["machine", "profile", "public"],
        profiles: await awsProfiles(env),
      }),
    },
  );
  const client = messagePort<Reply, Request>(port2 as unknown as MessagePortLike);
  try {
    const reply = await new Promise<Reply>((resolve) => {
      client.listen(resolve);
      client.post({ t: "signins", id: 1 });
    });
    expect(reply).toEqual({
      t: "offered",
      id: 1,
      signins: {
        modes: ["machine", "profile", "public"],
        profiles: ["default", "finance", "reader", "sso-work", "vault"],
      },
    });
    const wire = JSON.stringify(reply);
    for (const secret of SECRETS) expect(wire, secret).not.toContain(secret);
  } finally {
    client.close();
  }
});

test("an engine whose platform has no way of signing in to offer says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-profiles-connections-"));
  const { engine, done } = connect(undefined, undefined, connectionsIn(nodeStore(), dir));
  try {
    await expect(engine.signIns()).rejects.toThrow(
      "this engine has no way of signing in to offer · its platform connects to nothing",
    );
  } finally {
    done();
  }
});
