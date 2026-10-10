// Two AWS profiles, finance and marketing, each holding the keys to one
// bucket. Used by signing.test.ts and multifiles.test.ts.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AwsCredentials } from "../../src/store/s3.ts";
import { HOME_REGION } from "./regions.ts";

export const FINANCE: AwsCredentials = {
  accessKeyId: "AKIDFINANCE",
  secretAccessKey: "finance/secret",
  region: HOME_REGION,
};
export const MARKETING: AwsCredentials = {
  accessKeyId: "AKIDMARKETING",
  secretAccessKey: "marketing/secret",
  region: HOME_REGION,
};

/**
 * twoProfiles writes a temp ~/.aws folder: a credentials file with the
 * finance and marketing profiles, and a config file holding `config`. It
 * returns the folder path, for `profilesEnv`.
 */
export async function twoProfiles(config = ""): Promise<string> {
  const aws = await mkdtemp(join(tmpdir(), "uno-profiles-aws-"));
  await writeFile(
    join(aws, "credentials"),
    [
      "[finance]",
      `aws_access_key_id = ${FINANCE.accessKeyId}`,
      `aws_secret_access_key = ${FINANCE.secretAccessKey}`,
      "[marketing]",
      `aws_access_key_id = ${MARKETING.accessKeyId}`,
      `aws_secret_access_key = ${MARKETING.secretAccessKey}`,
      "",
    ].join("\n"),
  );
  await writeFile(join(aws, "config"), config);
  return aws;
}

/**
 * profilesEnv is an environment pointing at that folder. It clears
 * AWS_PROFILE and the session token, and sets the machine's own keys only
 * when `machine` is given.
 */
export function profilesEnv(
  aws: string,
  machine?: AwsCredentials,
): Record<string, string | undefined> {
  return {
    HOME: aws,
    AWS_CONFIG_FILE: join(aws, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(aws, "credentials"),
    AWS_REGION: HOME_REGION,
    AWS_PROFILE: undefined,
    AWS_DEFAULT_PROFILE: undefined,
    AWS_ACCESS_KEY_ID: machine?.accessKeyId,
    AWS_SECRET_ACCESS_KEY: machine?.secretAccessKey,
    AWS_SESSION_TOKEN: undefined,
  };
}
