// A stand-in for STS, on localhost. It answers AssumeRole only.
//
// It signs each request again with the secret of the claimed access key and
// refuses a mismatch. A role is handed out only to a caller its trust names,
// with the external ID the trust asks for. Every request is recorded in
// `seen`.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { signV4 } from "../../src/store/s3.ts";
import type { AwsCredentials } from "../../src/store/s3.ts";
import { amzDate } from "./standin.ts";

/**
 * One role: who may assume it, the external ID it needs, and the session it
 * hands out.
 */
export interface Trust {
  /** The access key ids allowed to assume it. */
  callers: string[];
  /** The external ID the trust requires, if any. */
  externalId?: string;
  /** The session's keys. */
  session: Required<Pick<AwsCredentials, "accessKeyId" | "secretAccessKey" | "sessionToken">>;
}

export interface Sts {
  endpoint: string;
  seen: Array<{
    caller: string;
    roleArn: string;
    externalId?: string;
    sessionName: string;
    region: string;
  }>;
  close(): Promise<void>;
}

export async function sts(
  secrets: readonly Omit<AwsCredentials, "region">[],
  roles: Map<string, Trust>,
): Promise<Sts> {
  const seen: Sts["seen"] = [];
  const byId = new Map(secrets.map((k) => [k.accessKeyId, k]));

  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const auth = req.headers["authorization"] ?? "";
    const caller = /Credential=([^/]+)\//.exec(auth)?.[1] ?? "";
    const scope = /Credential=[^/]+\/\d{8}\/([^/]+)\/([^/]+)\//.exec(auth);
    const region = scope?.[1] ?? "";
    const q = url.searchParams;
    const roleArn = q.get("RoleArn") ?? "";
    const externalId = q.get("ExternalId") ?? undefined;
    seen.push({ caller, roleArn, externalId, sessionName: q.get("RoleSessionName") ?? "", region });

    const refuse = (status: number, code: string, message: string): void => {
      res
        .writeHead(status, { "content-type": "text/xml" })
        .end(
          `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type>` +
            `<Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
        );
    };

    const signer = byId.get(caller);
    if (signer === undefined)
      return refuse(
        403,
        "InvalidClientTokenId",
        "The security token included in the request is invalid.",
      );
    const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
    const again = signV4(
      {
        method: req.method!,
        url,
        headers: Object.fromEntries(
          signed
            .filter((h) => h !== "host" && h !== "x-amz-date")
            .map((h) => [h, String(req.headers[h])]),
        ),
      },
      signer,
      region,
      "sts",
      amzDate(String(req.headers["x-amz-date"])),
    );
    if (scope?.[2] !== "sts" || again["authorization"] !== auth) {
      return refuse(
        403,
        "SignatureDoesNotMatch",
        "The request signature we calculated does not match the signature you provided.",
      );
    }
    if (q.get("Action") !== "AssumeRole" || q.get("Version") !== "2011-06-15") {
      return refuse(400, "InvalidAction", "Could not find operation");
    }
    const trust = roles.get(roleArn);
    if (trust === undefined || !trust.callers.includes(caller) || trust.externalId !== externalId) {
      return refuse(
        403,
        "AccessDenied",
        `User: ${caller} is not authorized to perform: sts:AssumeRole on resource: ${roleArn}`,
      );
    }
    const expiration = new Date(Date.now() + Number(q.get("DurationSeconds") ?? "3600") * 1000);
    res
      .writeHead(200, { "content-type": "text/xml" })
      .end(
        `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult>` +
          `<Credentials><AccessKeyId>${trust.session.accessKeyId}</AccessKeyId>` +
          `<SecretAccessKey>${trust.session.secretAccessKey}</SecretAccessKey>` +
          `<SessionToken>${trust.session.sessionToken}</SessionToken>` +
          `<Expiration>${expiration.toISOString()}</Expiration></Credentials>` +
          `<AssumedRoleUser><Arn>${roleArn}/${q.get("RoleSessionName")}</Arn></AssumedRoleUser>` +
          `</AssumeRoleResult></AssumeRoleResponse>`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
