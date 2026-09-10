// credential_process: a profile that hands signing in to another program.
//
// What is under test is that the program's keys are the ones used, that it is
// run again only once they expire, and that everything a program can do wrong
// -- fail, hang, print the wrong thing -- is a sentence naming the profile.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  connectionSigning,
  diskProvider,
  profileCredentials,
  splitCommand,
} from "../../src/store/node.ts";
import { s3Provider } from "../../src/store/s3.ts";
import { bytes, connect, indexed, openOne } from "../engine/harness.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { HOME_REGION } from "./regions.ts";
import { bucket } from "./standin.ts";
import type { Bucket } from "./standin.ts";

const FIXTURE = fileURLToPath(new URL("../testdata/credential-process.mjs", import.meta.url));
const HOUR_MS = 60 * 60_000;

/** What the fixture prints. */
const PRINTED = {
  accessKeyId: "AKIDPROCESS",
  secretAccessKey: "process/secret",
  sessionToken: "process-token",
};

let b: Bucket;
beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, undefined, {
    "acme-vault": {
      objects: new Map([["q3/ledger.csv", bytes]]),
      keys: { ...PRINTED, region: HOME_REGION },
    },
  });
});
afterAll(() => b.close());

/**
 * A machine whose one profile runs the fixture, from a folder with a space in
 * its name so the command line has to be quoted to reach it. Answers with the
 * environment, and a way to count how often the fixture ran.
 */
async function machine(expiration: string, answer = "keys", program = process.execPath) {
  const dir = await mkdtemp(join(tmpdir(), "uno process "));
  const runs = join(dir, "runs");
  await writeFile(runs, "");
  const command = [program, FIXTURE, runs, expiration, answer].map((w) => `"${w}"`).join(" ");
  await writeFile(
    join(dir, "config"),
    `[profile vault]\ncredential_process = ${command}\nregion = ${HOME_REGION}\n`,
  );
  await writeFile(join(dir, "credentials"), "");
  return {
    env: {
      HOME: dir,
      AWS_CONFIG_FILE: join(dir, "config"),
      AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
      AWS_REGION: undefined,
      AWS_PROFILE: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    },
    ran: async () => (await readFile(runs, "utf8")).split("\n").filter((l) => l !== "").length,
  };
}

const later = (): string => new Date(Date.now() + HOUR_MS).toISOString();

describe("a fixture script's credentials are used", () => {
  test("as the profile's keys, with its session token", async () => {
    const { env } = await machine(later());
    expect(await profileCredentials("vault", env)()).toEqual({
      ...PRINTED,
      region: HOME_REGION,
      as: "the AWS profile vault",
    });
  });

  test("to read a bucket that answers nobody else, through a connection", async () => {
    const { env, ran } = await machine(later());
    const vault = {
      format: 1,
      id: "vault",
      name: "Vault",
      provider: "s3" as const,
      bucket: "acme-vault",
      prefix: "",
      auth: { mode: "profile" as const, profile: "vault" },
      created: undefined,
      modified: undefined,
    };
    const s3 = s3Provider({
      credentials: connectionSigning(() => [vault], env),
      endpoint: b.endpoint,
    });
    const { engine, done } = connect(undefined, [diskProvider(), s3]);
    try {
      const ledger = await openOne(engine, {
        name: "ledger.csv",
        path: "s3://acme-vault/q3/ledger.csv",
      });
      await indexed(ledger);
      expect(ledger.progress.rows).toBe(ROWS);
      expect(await ran()).toBe(1);
    } finally {
      done();
    }
  });
});

// The task's own sentence: it is run again only after they expire.
describe("the program is run again only once its keys expire", () => {
  test("keys good for an hour are reused, and it runs once", async () => {
    const { env, ran } = await machine(later());
    const creds = profileCredentials("vault", env);
    for (let i = 0; i < 4; i++) await creds();
    expect(await ran()).toBe(1);
  });

  // Keys a minute from expiry would lapse on the way to S3, so each ask runs
  // the program for fresh ones.
  test("keys about to expire are not reused, and it runs each time", async () => {
    const { env, ran } = await machine(new Date(Date.now() + 60_000).toISOString());
    const creds = profileCredentials("vault", env);
    await creds();
    await creds();
    expect(await ran()).toBe(2);
  });

  // No Expiration is the CLI's way of saying the keys do not expire.
  test("keys with no expiration are kept for as long as the engine runs", async () => {
    const { env, ran } = await machine("none");
    const creds = profileCredentials("vault", env);
    for (let i = 0; i < 4; i++) await creds();
    expect(await ran()).toBe(1);
  });
});

describe("a program that does not answer as it should is named", () => {
  test("one that fails says the first line it wrote to stderr", async () => {
    const { env } = await machine(later(), "fail");
    await expect(profileCredentials("vault", env)()).rejects.toThrow(
      "the AWS profile vault's credential_process failed · vault is sealed",
    );
  });

  test("one that prints something that is not JSON", async () => {
    const { env } = await machine(later(), "junk");
    await expect(profileCredentials("vault", env)()).rejects.toThrow(
      "the AWS profile vault's credential_process did not print JSON",
    );
  });

  test("one that answers in a version this build does not read", async () => {
    const { env } = await machine(later(), "v2");
    await expect(profileCredentials("vault", env)()).rejects.toThrow(
      "the AWS profile vault's credential_process printed version 2 · uno reads version 1",
    );
  });

  test("one that is not there", async () => {
    const { env } = await machine(later(), "keys", "/nowhere/uno-vault-helper");
    await expect(profileCredentials("vault", env)()).rejects.toThrow(
      "the AWS profile vault's credential_process failed · there is no program called /nowhere/uno-vault-helper",
    );
  });
});

// Split the way a shell splits, and nothing more: no shell ever sees the line.
describe("the command line is split into words without a shell", () => {
  test("quotes keep spaces, and a backslash keeps the next character", () => {
    expect(splitCommand(`aws-vault exec "my profile" --json`)).toEqual([
      "aws-vault",
      "exec",
      "my profile",
      "--json",
    ]);
    expect(splitCommand(`helper 'a "b" c' d\\ e "f\\"g"`)).toEqual([
      "helper",
      'a "b" c',
      "d e",
      'f"g',
    ]);
    expect(splitCommand(`  helper   ""  `)).toEqual(["helper", ""]);
  });

  test("what a shell would run as a second command stays a word", () => {
    expect(splitCommand("helper; rm -rf ~")).toEqual(["helper;", "rm", "-rf", "~"]);
    expect(splitCommand("helper $(whoami) `id`")).toEqual(["helper", "$(whoami)", "`id`"]);
  });

  test("a quote left open is refused rather than guessed at", () => {
    expect(() => splitCommand(`helper "unclosed`)).toThrow(/" with no " to close it/);
  });
});
