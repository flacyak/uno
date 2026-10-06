// The two IAM documents a person writes into their own account so uno's
// hosted engine may read one bucket: the role's trust policy and its
// permission policy.
//
// They are generated here, from the trust the engine reports and the bucket
// and prefix the person typed, so a person who has never seen an IAM policy
// connects a bucket from the copied JSON alone. The documents are text, and
// nothing here reaches a network or a file.

/** What the role's trust policy names: the engine's principal and the tenant's external ID. */
export interface RoleTrust {
  principal: string;
  externalId: string;
}

/** What the two documents are written for. */
export interface RolePolicyAsk extends RoleTrust {
  bucket: string;
  /** A folder in the bucket, as a connection writes it: "" or "shop/2025/". */
  prefix: string;
}

/** The two documents, each as the JSON a policy editor takes. */
export interface RolePolicies {
  trust: string;
  permission: string;
}

/** The policy language version every document names. */
const POLICY_VERSION = "2012-10-17";

/**
 * A policy document, as JSON with two-space indent, the way the console's
 * policy editor shows one. It is pasted into an editor rather than saved as
 * a file, so it ends with its closing brace and no newline.
 */
function document(statements: Record<string, unknown>[]): string {
  return JSON.stringify({ Version: POLICY_VERSION, Statement: statements }, undefined, 2);
}

/**
 * trustPolicy is the role's trust policy: the engine's principal may assume
 * it, and only with the external ID the tenant was issued. The condition is
 * what keeps another tenant who learns the role's ARN out: the engine sends
 * the ID of the tenant asking, so theirs fails the match.
 */
export function trustPolicy(trust: RoleTrust): string {
  return document([
    {
      Effect: "Allow",
      Principal: { AWS: trust.principal },
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "sts:ExternalId": trust.externalId } },
    },
  ]);
}

/**
 * permissionPolicy is the role's permission policy: list the bucket under
 * the prefix, and read objects and their versions under it. With no prefix
 * the whole bucket is listed and read.
 *
 * The listing condition refuses HeadBucket, which names no prefix, and S3
 * still answers that refusal with the bucket's region, which is all the
 * engine reads from it.
 */
export function permissionPolicy(ask: Pick<RolePolicyAsk, "bucket" | "prefix">): string {
  const bucket = `arn:aws:s3:::${ask.bucket}`;
  const list: Record<string, unknown> = {
    Effect: "Allow",
    Action: "s3:ListBucket",
    Resource: bucket,
  };
  if (ask.prefix !== "") {
    list["Condition"] = { StringLike: { "s3:prefix": [`${ask.prefix}*`] } };
  }
  return document([
    list,
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:GetObjectVersion"],
      Resource: `${bucket}/${ask.prefix}*`,
    },
  ]);
}

/** rolePolicies is both documents for one connection. */
export function rolePolicies(ask: RolePolicyAsk): RolePolicies {
  return { trust: trustPolicy(ask), permission: permissionPolicy(ask) };
}

/** The account inside an ARN: the twelve digits after the two empty fields. */
const ARN_ACCOUNT = /^arn:aws(?:-[a-z]+)*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):/;

/**
 * accountOf is the AWS account an ARN belongs to, or undefined for text that
 * is not an ARN with one. It is what the console asks for when a role is made
 * to trust "another AWS account".
 */
export function accountOf(arn: string): string | undefined {
  return ARN_ACCOUNT.exec(arn.trim())?.[1];
}

/**
 * roleNameOf is the name of a role from its ARN: what follows the last slash,
 * so a role with a path reads as its name alone. Text that is not a role ARN
 * is returned as it is.
 */
export function roleNameOf(roleArn: string): string {
  const at = roleArn.indexOf(":role/");
  if (at < 0) return roleArn;
  const path = roleArn.slice(at + ":role/".length);
  return path.slice(path.lastIndexOf("/") + 1);
}
