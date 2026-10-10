// connectionSigning: each request signed by the connection covering it.
//
// Which connection covers an address, what each auth mode sends, and that a
// connection saved while the engine runs is used by its next request.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { Connection } from "../../src/library/index.ts";
import { connectionsIn, saveConnection } from "../../src/store/index.ts";
import { connectionSigning, diskProvider, nodeStore } from "../../src/store/node.ts";
import type { AwsCredentials } from "../../src/store/s3.ts";
import { s3Provider } from "../../src/store/s3.ts";
import { bytes, connect, indexed, openOne } from "../engine/harness.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { HOME_REGION } from "./regions.ts";
import { KEYS, bucket } from "./standin.ts";
import type { Bucket } from "./standin.ts";
import { FINANCE, MARKETING, profilesEnv, twoProfiles } from "./profiles.ts";

const LEDGER = "q3/ledger.csv";
const ADS = "ads/ads.csv";
const OPEN = "census/2025.csv";

let b: Bucket;
let aws: string;

beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, undefined, {
    "acme-finance": { objects: new Map([[LEDGER, bytes]]), keys: FINANCE },
    "acme-marketing": { objects: new Map([[ADS, bytes]]), keys: MARKETING },
    "open-data": { objects: new Map([[OPEN, bytes]]), public: true },
  });
  aws = await twoProfiles("[profile finance]\nregion = eu-west-1\n");
});

afterAll(() => b.close());

/**
 * The environment of a machine with the two profiles and, when `machine` is
 * given, its own keys.
 */
function env(machine?: AwsCredentials): Record<string, string | undefined> {
  return profilesEnv(aws, machine);
}

function connection(
  id: string,
  bucketName: string,
  auth: Connection["auth"],
  prefix = "",
): Connection {
  return {
    format: 1,
    id,
    name: id,
    provider: "s3",
    bucket: bucketName,
    prefix,
    auth,
    created: undefined,
    modified: undefined,
  };
}

/**
 * engine wires an engine the way the desktop's is: connections kept in a
 * folder, and an S3 provider that signs each request by the one covering it.
 */
async function engine(saved: Connection[], machine?: AwsCredentials) {
  const dir = await mkdtemp(join(tmpdir(), "uno-signing-connections-"));
  const store = nodeStore();
  for (const c of saved) await saveConnection(store, dir, c);
  const kept = connectionsIn(store, dir);
  const s3 = s3Provider({
    credentials: connectionSigning(() => kept.all, env(machine)),
    endpoint: b.endpoint,
  });
  return { ...connect(undefined, [diskProvider(), s3], kept), store, dir };
}

/** How many requests the stand-in had seen when a test began. */
let from = 0;
beforeEach(() => {
  from = b.seen.length;
});

/** The access keys this test's requests to one bucket were signed with, once each. */
function keysFor(bucketName: string): string[] {
  const mine = b.seen.slice(from).filter((r) => r.path.startsWith(`/${bucketName}/`));
  return [...new Set(mine.map((r) => r.key))];
}

describe("which connection signs", () => {
  test("two connections on two profiles read two buckets in one workspace", async () => {
    const { engine: e, done } = await engine([
      connection("finance", "acme-finance", { mode: "profile", profile: "finance" }),
      connection("marketing", "acme-marketing", { mode: "profile", profile: "marketing" }),
    ]);
    try {
      const ledger = await openOne(e, { name: "ledger.csv", path: `s3://acme-finance/${LEDGER}` });
      const ads = await openOne(e, { name: "ads.csv", path: `s3://acme-marketing/${ADS}` });
      await Promise.all([indexed(ledger), indexed(ads)]);
      expect(ledger.progress.rows).toBe(ROWS);
      expect(ads.progress.rows).toBe(ROWS);
      expect(keysFor("acme-finance")).toEqual([FINANCE.accessKeyId]);
      expect(keysFor("acme-marketing")).toEqual([MARKETING.accessKeyId]);
    } finally {
      done();
    }
  });

  // The refusal names the connection and the profile.
  test("a profile without access to a bucket is refused, named", async () => {
    const { engine: e, done } = await engine([
      connection("marketing", "acme-finance", { mode: "profile", profile: "marketing" }),
    ]);
    try {
      await expect(
        e.open({ name: "ledger.csv", path: `s3://acme-finance/${LEDGER}` }),
      ).rejects.toThrow(
        "s3://acme-finance/q3/ledger.csv: access denied · marketing (the AWS profile marketing) cannot read it",
      );
    } finally {
      done();
    }
  });

  test("of two connections to one bucket, the one with the longer prefix signs", async () => {
    const { engine: e, done } = await engine([
      connection("whole", "acme-finance", { mode: "profile", profile: "marketing" }),
      connection("q3", "acme-finance", { mode: "profile", profile: "finance" }, "q3/"),
    ]);
    try {
      const ledger = await openOne(e, { name: "ledger.csv", path: `s3://acme-finance/${LEDGER}` });
      await indexed(ledger);
      expect(keysFor("acme-finance")).toEqual([FINANCE.accessKeyId]);
    } finally {
      done();
    }
  });

  test("an address no connection covers signs with the machine's own credentials", async () => {
    const { engine: e, done } = await engine([], KEYS);
    try {
      const f = await openOne(e, {
        name: "sales-q3.csv",
        path: "s3://acme-exports/2025/sales-q3.csv",
      });
      await indexed(f);
      expect(keysFor("acme-exports")).toEqual([KEYS.accessKeyId]);
    } finally {
      done();
    }
  });
});

describe("the ways a connection signs in", () => {
  test("public reads a bucket without signing anything", async () => {
    const { engine: e, done } = await engine(
      [connection("census", "open-data", { mode: "public" })],
      KEYS,
    );
    try {
      const f = await openOne(e, { name: "2025.csv", path: `s3://open-data/${OPEN}` });
      await indexed(f);
      expect(keysFor("open-data")).toEqual([""]);
    } finally {
      done();
    }
  });

  test("machine signs with the machine's chain, for the bucket it names", async () => {
    const { engine: e, done } = await engine(
      [connection("exports", "acme-exports", { mode: "machine" })],
      KEYS,
    );
    try {
      const f = await openOne(e, {
        name: "sales-q3.csv",
        path: "s3://acme-exports/2025/sales-q3.csv",
      });
      await indexed(f);
      expect(keysFor("acme-exports")).toEqual([KEYS.accessKeyId]);
    } finally {
      done();
    }
  });

  test("role is refused by name on the desktop", async () => {
    const roleArn = "arn:aws:iam::210987654321:role/uno-read";
    const { engine: e, done } = await engine(
      [connection("lake", "acme-finance", { mode: "role", roleArn })],
      KEYS,
    );
    try {
      await expect(
        e.open({ name: "ledger.csv", path: `s3://acme-finance/${LEDGER}` }),
      ).rejects.toThrow(
        `lake signs in with a role, which only uno's hosted engine takes on · on the desktop, connect it with a profile that can assume ${roleArn}`,
      );
    } finally {
      done();
    }
  });

  test("a profile that does not exist is refused by name", async () => {
    const { engine: e, done } = await engine([
      connection("typo", "acme-finance", { mode: "profile", profile: "fnance" }),
    ]);
    try {
      await expect(
        e.open({ name: "ledger.csv", path: `s3://acme-finance/${LEDGER}` }),
      ).rejects.toThrow(
        "there is no AWS profile called fnance in ~/.aws/config or ~/.aws/credentials",
      );
    } finally {
      done();
    }
  });
});

test("a connection saved while the engine runs signs its next request", async () => {
  const { engine: e, done, store, dir } = await engine([]);
  try {
    const ref = { name: "ledger.csv", path: `s3://acme-finance/${LEDGER}` };
    await expect(e.open(ref)).rejects.toThrow(/^no AWS credentials/);

    await saveConnection(
      store,
      dir,
      connection("finance", "acme-finance", { mode: "profile", profile: "finance" }),
    );
    await e.connections();
    const ledger = await openOne(e, ref);
    await indexed(ledger);
    expect(ledger.progress.rows).toBe(ROWS);
  } finally {
    done();
  }
});
