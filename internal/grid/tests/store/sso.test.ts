// SSO profiles: the token `aws sso login` cached is traded at the portal for
// a role's keys, which sign requests to a bucket.
//
// Both config layouts are read. An expired, missing, unreadable or refused
// token is an error naming the command that fixes it. The portal is asked
// only with a token that looks good on disk.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { awsCredentials, diskProvider, profileCredentials } from "../../src/store/node.ts";
import { connectionSigning } from "../../src/store/node.ts";
import { s3Provider } from "../../src/store/s3.ts";
import { bytes, connect, indexed, openOne } from "../engine/harness.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { portal } from "./portal.ts";
import type { Grant, Portal } from "./portal.ts";
import { HOME_REGION } from "./regions.ts";
import { bucket } from "./standin.ts";
import type { Bucket } from "./standin.ts";

const ACCOUNT = "111122223333";
const ROLE = "FinanceRead";
const HOUR_MS = 60 * 60_000;

/** What the portal hands out: a role's keys, with the session token SSO keys carry. */
const ROLE_KEYS = {
  accessKeyId: "ASIDFINANCESSO",
  secretAccessKey: "sso/finance/secret",
  sessionToken: "sso-session-token",
};

const CONFIG = `
[profile finance-sso]
sso_session = acme
sso_account_id = ${ACCOUNT}
sso_role_name = ${ROLE}
region = ${HOME_REGION}

[sso-session acme]
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile legacy-sso]
sso_start_url = https://legacy.awsapps.com/start
sso_region = us-east-2
sso_account_id = ${ACCOUNT}
sso_role_name = ${ROLE}
region = ${HOME_REGION}
`;

let p: Portal;
let b: Bucket;
let grants: Map<string, Grant>;

beforeAll(async () => {
  grants = new Map();
  p = await portal(grants);
  // The bucket accepts only the role's keys.
  b = await bucket(undefined, HOME_REGION, undefined, {
    "acme-finance": {
      objects: new Map([["q3/ledger.csv", bytes]]),
      keys: { ...ROLE_KEYS, region: HOME_REGION },
    },
  });
});

afterAll(async () => {
  await p.close();
  await b.close();
});

/** A home folder with the config above and, for each token, the cache file `aws sso login` would leave. */
async function home(tokens: Record<string, { token: string; expires: Date | string }>) {
  const dir = await mkdtemp(join(tmpdir(), "uno-sso-"));
  await mkdir(join(dir, ".aws", "sso", "cache"), { recursive: true });
  await writeFile(join(dir, ".aws", "config"), CONFIG);
  await writeFile(join(dir, ".aws", "credentials"), "");
  for (const [key, { token, expires }] of Object.entries(tokens)) {
    const name = createHash("sha1").update(key).digest("hex") + ".json";
    await writeFile(
      join(dir, ".aws", "sso", "cache", name),
      JSON.stringify({
        startUrl: "https://acme.awsapps.com/start",
        region: "us-east-1",
        accessToken: token,
        expiresAt: typeof expires === "string" ? expires : expires.toISOString(),
      }),
    );
  }
  return {
    HOME: dir,
    AWS_CONFIG_FILE: undefined,
    AWS_SHARED_CREDENTIALS_FILE: undefined,
    AWS_ENDPOINT_URL_SSO: p.endpoint,
    AWS_REGION: undefined,
    AWS_DEFAULT_REGION: undefined,
    AWS_PROFILE: undefined,
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_SESSION_TOKEN: undefined,
  };
}

/** A token the portal honours, for the role, until an hour from now. */
function grant(token: string, expiration = new Date(Date.now() + HOUR_MS)): void {
  grants.set(token, { accountId: ACCOUNT, roleName: ROLE, creds: ROLE_KEYS, expiration });
}

beforeEach(() => {
  grants.clear();
  p.seen.length = 0;
});

describe("a stand-in portal hands out credentials", () => {
  test("for a profile that names an sso-session", async () => {
    grant("tok-acme");
    const env = await home({
      acme: { token: "tok-acme", expires: new Date(Date.now() + HOUR_MS) },
    });

    expect(await profileCredentials("finance-sso", env)()).toEqual({
      ...ROLE_KEYS,
      region: HOME_REGION,
      as: "the AWS profile finance-sso",
    });
    expect(p.seen).toEqual([{ account: ACCOUNT, role: ROLE, token: "tok-acme" }]);
  });

  // The layout before sso-session sections: the portal is in the profile, and
  // the token is cached under the SHA-1 of its start URL.
  test("for a profile in the older layout, with the portal in the profile", async () => {
    grant("tok-legacy");
    const env = await home({
      "https://legacy.awsapps.com/start": {
        token: "tok-legacy",
        expires: new Date(Date.now() + HOUR_MS),
      },
    });
    expect((await profileCredentials("legacy-sso", env)()).accessKeyId).toBe(ROLE_KEYS.accessKeyId);
  });

  // Older CLIs wrote the expiry with a UTC suffix in place of the Z.
  test("with an expiry written the way older CLIs wrote it", async () => {
    grant("tok-acme");
    const later = new Date(Date.now() + HOUR_MS).toISOString().replace(/\.\d{3}Z$/, "UTC");
    const env = await home({ acme: { token: "tok-acme", expires: later } });
    expect((await profileCredentials("finance-sso", env)()).sessionToken).toBe(
      ROLE_KEYS.sessionToken,
    );
  });

  // The portal's keys sign every request through a connection naming the
  // profile.
  test("and they read a bucket through a connection naming the profile", async () => {
    grant("tok-acme");
    const env = await home({
      acme: { token: "tok-acme", expires: new Date(Date.now() + HOUR_MS) },
    });
    const lake = {
      format: 1,
      id: "finance",
      name: "Finance",
      provider: "s3" as const,
      bucket: "acme-finance",
      prefix: "",
      auth: { mode: "profile" as const, profile: "finance-sso" },
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
        path: "s3://acme-finance/q3/ledger.csv",
      });
      await indexed(ledger);
      expect(ledger.progress.rows).toBe(ROWS);
      // The portal was asked once.
      expect(p.seen).toHaveLength(1);
    } finally {
      done();
    }
  });

  test("for the machine's own profile, when AWS_PROFILE names an SSO one", async () => {
    grant("tok-acme");
    const env = {
      ...(await home({ acme: { token: "tok-acme", expires: new Date(Date.now() + HOUR_MS) } })),
      AWS_PROFILE: "finance-sso",
    };
    expect((await awsCredentials(env)()).accessKeyId).toBe(ROLE_KEYS.accessKeyId);
  });
});

describe("uno never signs in for anybody", () => {
  // An expired token is refused on disk, and the portal stays idle.
  test("an expired token says to sign in with aws sso login", async () => {
    grant("tok-acme");
    const env = await home({
      acme: { token: "tok-acme", expires: new Date("2026-09-20T12:00:00Z") },
    });
    await expect(profileCredentials("finance-sso", env)()).rejects.toThrow(
      "the AWS profile finance-sso is not signed in · its SSO sign-in expired at 2026-09-20T12:00:00.000Z · sign in with `aws sso login --profile finance-sso`",
    );
    expect(p.seen).toEqual([]);
  });

  test("a profile nobody signed in with says the same", async () => {
    const env = await home({});
    await expect(profileCredentials("finance-sso", env)()).rejects.toThrow(
      "the AWS profile finance-sso is not signed in · uno found no SSO sign-in for it · sign in with `aws sso login --profile finance-sso`",
    );
  });

  // A cache file holding broken JSON, or null.
  test("a cache file that is not JSON says the same", async () => {
    const env = await home({});
    const name = createHash("sha1").update("acme").digest("hex") + ".json";
    const cached = join(env.HOME, ".aws", "sso", "cache", name);
    await writeFile(cached, `{"startUrl": "https://acme.awsapps.com/start", "accessTok`);
    await expect(profileCredentials("finance-sso", env)()).rejects.toThrow(
      "the AWS profile finance-sso is not signed in · its cached SSO sign-in could not be read · sign in with `aws sso login --profile finance-sso`",
    );

    await writeFile(cached, "null");
    await expect(profileCredentials("finance-sso", env)()).rejects.toThrow(
      "the AWS profile finance-sso is not signed in · its cached SSO sign-in could not be read · sign in with `aws sso login --profile finance-sso`",
    );
    expect(p.seen).toEqual([]);
  });

  // A token still good on disk and revoked at the portal.
  test("a token the portal turns away says the same", async () => {
    const env = await home({
      acme: { token: "tok-revoked", expires: new Date(Date.now() + HOUR_MS) },
    });
    await expect(profileCredentials("finance-sso", env)()).rejects.toThrow(
      "the AWS profile finance-sso is not signed in · the SSO portal turned its sign-in away · sign in with `aws sso login --profile finance-sso`",
    );
  });
});

describe("the portal is asked as seldom as it can be", () => {
  test("keys are reused until shortly before they expire", async () => {
    grant("tok-acme");
    const env = await home({
      acme: { token: "tok-acme", expires: new Date(Date.now() + HOUR_MS) },
    });
    const creds = profileCredentials("finance-sso", env);
    await creds();
    await creds();
    await creds();
    expect(p.seen).toHaveLength(1);
  });

  // Keys within a minute of expiry are traded again.
  test("keys about to expire are traded again rather than reused", async () => {
    grant("tok-acme", new Date(Date.now() + 60_000));
    const env = await home({
      acme: { token: "tok-acme", expires: new Date(Date.now() + HOUR_MS) },
    });
    const creds = profileCredentials("finance-sso", env);
    await creds();
    await creds();
    expect(p.seen).toHaveLength(2);
  });
});
