/**
 * @fileoverview A stand-in for what a host answers on: the EC2 instance
 * metadata service, v2 and v1, and the credentials endpoint beside a
 * container. On localhost. Every request is recorded in `seen`.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AwsCredentials } from '@store/s3';

/** The keys an endpoint hands out. */
export type HostKeys = Required<
  Pick<AwsCredentials, 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>
>;

/** How long the keys handed out last. */
const HOURS_6_MS = 6 * 60 * 60_000;

export interface Host {
  endpoint: string;
  /** The role the instance runs as. Undefined for an instance with none. */
  role?: { name: string; keys: HostKeys };
  /** Whether IMDSv2 tokens are handed out. Off, the token request is answered 403 and v1 is served. */
  v2: boolean;
  /** The container endpoint: its path, its keys, and the token it checks, if any. */
  container?: { path: string; keys: HostKeys; token?: string };
  seen: Array<{
    method: string;
    path: string;
    token?: string;
    authorization?: string;
  }>;
  close(): Promise<void>;
}

const IMDS_TOKEN = 'imds-token';
const ROLES = '/latest/meta-data/iam/security-credentials/';

export async function host(): Promise<Host> {
  const h: Host = {
    endpoint: '',
    v2: true,
    seen: [],
    close: () => Promise.resolve(),
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url!, `http://${req.headers.host}`).pathname;
    const token = req.headers['x-aws-ec2-metadata-token'];
    const authorization = req.headers['authorization'];
    h.seen.push({
      method: req.method!,
      path,
      token: typeof token === 'string' ? token : undefined,
      authorization,
    });

    const answer = (
      status: number,
      body: string,
      type = 'text/plain',
    ): void => {
      res.writeHead(status, { 'content-type': type }).end(body);
    };
    const expiration = new Date(Date.now() + HOURS_6_MS).toISOString();

    if (req.method === 'PUT' && path === '/latest/api/token') {
      return h.v2 ? answer(200, IMDS_TOKEN) : answer(403, 'Forbidden');
    }
    if (path.startsWith(ROLES)) {
      // IMDSv2 on, a request without the token is refused the way IMDS does.
      if (h.v2 && token !== IMDS_TOKEN) return answer(401, 'Unauthorized');
      if (h.role === undefined) return answer(404, 'Not Found');
      const name = path.slice(ROLES.length);
      if (name === '') return answer(200, h.role.name);
      if (name !== h.role.name) return answer(404, 'Not Found');
      return answer(
        200,
        JSON.stringify({
          Code: 'Success',
          LastUpdated: new Date().toISOString(),
          Type: 'AWS-HMAC',
          AccessKeyId: h.role.keys.accessKeyId,
          SecretAccessKey: h.role.keys.secretAccessKey,
          Token: h.role.keys.sessionToken,
          Expiration: expiration,
        }),
        'application/json',
      );
    }
    if (h.container !== undefined && path === h.container.path) {
      const want = h.container.token;
      if (want !== undefined && authorization !== want)
        return answer(401, 'Unauthorized');
      return answer(
        200,
        JSON.stringify({
          RoleArn: 'arn:aws:iam::210987654321:role/task',
          AccessKeyId: h.container.keys.accessKeyId,
          SecretAccessKey: h.container.keys.secretAccessKey,
          Token: h.container.keys.sessionToken,
          Expiration: expiration,
        }),
        'application/json',
      );
    }
    return answer(404, 'Not Found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  h.endpoint = `http://127.0.0.1:${port}`;
  h.close = () => new Promise((resolve) => server.close(() => resolve()));
  return h;
}
