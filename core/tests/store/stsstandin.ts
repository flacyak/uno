/**
 * @fileoverview A stand-in for STS, on localhost. It answers AssumeRole and
 * AssumeRoleWithWebIdentity.
 *
 * It signs each AssumeRole again with the secret of the claimed access key
 * and refuses a mismatch. A role is handed out only to a caller its trust
 * names, with the external ID the trust asks for, or to a web identity token
 * its trust names. Every request is recorded in `seen`; for a web identity
 * call, `caller` is the token.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { signV4 } from '@store/s3';
import type { AwsCredentials } from '@store/s3';
import { amzDate } from './standin.ts';

/**
 * One role: who may assume it, the external ID it needs, and the session it
 * hands out.
 */
export interface Trust {
  /** The access key ids allowed to assume it. */
  callers: string[];
  /** The web identity tokens allowed to assume it. */
  tokens?: string[];
  /** The external ID the trust requires, if any. */
  externalId?: string;
  /** The session's keys. */
  session: Required<
    Pick<AwsCredentials, 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>
  >;
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

/**
 * sts starts the stand-in on a free port of localhost.
 * @param secrets the keys callers sign with
 * @param roles the roles on offer, by ARN
 * @return the stand-in, with its endpoint and what it saw
 */
export async function sts(
  secrets: readonly Omit<AwsCredentials, 'region'>[],
  roles: Map<string, Trust>,
): Promise<Sts> {
  const seen: Sts['seen'] = [];
  const byId = new Map(secrets.map((k) => [k.accessKeyId, k]));

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => answer(Buffer.concat(chunks).toString()));

    /** answer handles the request once its body is in. */
    const answer = (body: string): void => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      // A signed AssumeRole carries its query in the URL. An unsigned
      // AssumeRoleWithWebIdentity posts it as a form.
      const q =
        req.method === 'POST' ? new URLSearchParams(body) : url.searchParams;
      const webIdentity = q.get('Action') === 'AssumeRoleWithWebIdentity';
      const auth = req.headers['authorization'] ?? '';
      const caller = webIdentity
        ? (q.get('WebIdentityToken') ?? '')
        : (/Credential=([^/]+)\//.exec(auth)?.[1] ?? '');
      const scope = /Credential=[^/]+\/\d{8}\/([^/]+)\/([^/]+)\//.exec(auth);
      const region = scope?.[1] ?? '';
      const roleArn = q.get('RoleArn') ?? '';
      const externalId = q.get('ExternalId') ?? undefined;
      seen.push({
        caller,
        roleArn,
        externalId,
        sessionName: q.get('RoleSessionName') ?? '',
        region,
      });

      const refuse = (status: number, code: string, message: string): void => {
        res
          .writeHead(status, { 'content-type': 'text/xml' })
          .end(
            `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type>` +
              `<Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
          );
      };

      const session = (trust: Trust): void => {
        const expiration = new Date(
          Date.now() + Number(q.get('DurationSeconds') ?? '3600') * 1000,
        );
        res
          .writeHead(200, { 'content-type': 'text/xml' })
          .end(
            `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult>` +
              `<Credentials><AccessKeyId>${trust.session.accessKeyId}</AccessKeyId>` +
              `<SecretAccessKey>${trust.session.secretAccessKey}</SecretAccessKey>` +
              `<SessionToken>${trust.session.sessionToken}</SessionToken>` +
              `<Expiration>${expiration.toISOString()}</Expiration></Credentials>` +
              `<AssumedRoleUser><Arn>${roleArn}/${q.get('RoleSessionName')}</Arn></AssumedRoleUser>` +
              `</AssumeRoleResult></AssumeRoleResponse>`,
          );
      };

      if (webIdentity) {
        if (q.get('Version') !== '2011-06-15')
          return refuse(400, 'InvalidAction', 'Could not find operation');
        const trust = roles.get(roleArn);
        if (trust === undefined || !(trust.tokens ?? []).includes(caller)) {
          return refuse(
            403,
            'AccessDenied',
            `Not authorized to perform sts:AssumeRoleWithWebIdentity on resource: ${roleArn}`,
          );
        }
        return session(trust);
      }

      const signer = byId.get(caller);
      if (signer === undefined)
        return refuse(
          403,
          'InvalidClientTokenId',
          'The security token included in the request is invalid.',
        );
      const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? [];
      const again = signV4(
        {
          method: req.method!,
          url,
          headers: Object.fromEntries(
            signed
              .filter((h) => h !== 'host' && h !== 'x-amz-date')
              .map((h) => [h, String(req.headers[h])]),
          ),
        },
        signer,
        region,
        'sts',
        amzDate(String(req.headers['x-amz-date'])),
      );
      if (scope?.[2] !== 'sts' || again['authorization'] !== auth) {
        return refuse(
          403,
          'SignatureDoesNotMatch',
          'The request signature we calculated does not match the signature you provided.',
        );
      }
      if (
        q.get('Action') !== 'AssumeRole' ||
        q.get('Version') !== '2011-06-15'
      ) {
        return refuse(400, 'InvalidAction', 'Could not find operation');
      }
      const trust = roles.get(roleArn);
      if (
        trust === undefined ||
        !trust.callers.includes(caller) ||
        trust.externalId !== externalId
      ) {
        return refuse(
          403,
          'AccessDenied',
          `User: ${caller} is not authorized to perform: sts:AssumeRole on resource: ${roleArn}`,
        );
      }
      session(trust);
    };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
