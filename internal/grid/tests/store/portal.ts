// A stand-in for the AWS SSO portal, on localhost.
//
// It answers GET /federation/credentials with the role keys granted to the
// token in the x-amz-sso_bearer_token header, and refuses an unknown token.
// It records every request in `seen`.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { AwsCredentials } from "../../src/store/s3.ts";

/** The keys one token is granted: one role in one account, with an expiry. */
export interface Grant {
  accountId: string;
  roleName: string;
  creds: Required<Pick<AwsCredentials, "accessKeyId" | "secretAccessKey" | "sessionToken">>;
  expiration: Date;
}

export interface Portal {
  endpoint: string;
  seen: Array<{ account: string; role: string; token: string }>;
  close(): Promise<void>;
}

export async function portal(grants: Map<string, Grant>): Promise<Portal> {
  const seen: Portal["seen"] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const account = url.searchParams.get("account_id") ?? "";
    const role = url.searchParams.get("role_name") ?? "";
    const token = String(req.headers["x-amz-sso_bearer_token"] ?? "");
    seen.push({ account, role, token });

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (url.pathname !== "/federation/credentials") return json(404, { message: "not found" });
    const grant = grants.get(token);
    if (grant === undefined) {
      return json(401, { message: "Session token not found or invalid" });
    }
    if (grant.accountId !== account || grant.roleName !== role) {
      return json(403, { message: "No access" });
    }
    json(200, {
      roleCredentials: { ...grant.creds, expiration: grant.expiration.getTime() },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
