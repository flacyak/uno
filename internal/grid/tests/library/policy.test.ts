// The IAM documents generated for a role connection: the trust policy names
// the principal and the external ID, the permission policy is scoped to the
// bucket and prefix, and both are JSON a policy editor takes as they are.

import { describe, expect, test } from 'vite-plus/test';

import {
  accountOf,
  permissionPolicy,
  roleNameOf,
  rolePolicies,
  trustPolicy,
} from '#library';

const TRUST = {
  principal: 'arn:aws:iam::111122223333:role/uno-engine',
  externalId: 'uno-t-7f3c9a21e04b7f3c9a21e04b7f3c9a21',
};

interface Statement {
  Effect: string;
  Principal?: { AWS: string };
  Action: string | string[];
  Resource?: string;
  Condition?: Record<string, Record<string, string | string[]>>;
}

interface Policy {
  Version: string;
  Statement: Statement[];
}

/** A document read back as a policy editor would read it. */
function read(text: string): Policy {
  // Pasted into an editor, so it ends with its closing brace and no newline.
  expect(text.endsWith('}')).toBe(true);
  return JSON.parse(text) as Policy;
}

test('the trust policy lets the principal assume the role with the external ID alone', () => {
  const policy = read(trustPolicy(TRUST));
  expect(policy.Version).toBe('2012-10-17');
  expect(policy.Statement).toEqual([
    {
      Effect: 'Allow',
      Principal: { AWS: TRUST.principal },
      Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:ExternalId': TRUST.externalId } },
    },
  ]);
});

describe('the permission policy', () => {
  test('lists and reads under a prefix', () => {
    const policy = read(
      permissionPolicy({ bucket: 'acme-finance-lake', prefix: 'exports/' }),
    );
    expect(policy.Statement).toEqual([
      {
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: 'arn:aws:s3:::acme-finance-lake',
        Condition: { StringLike: { 's3:prefix': ['exports/*'] } },
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: 'arn:aws:s3:::acme-finance-lake/exports/*',
      },
    ]);
  });

  test('a nested folder is one prefix', () => {
    const [list, get] = read(
      permissionPolicy({ bucket: 'acme-exports', prefix: 'shop/2025/' }),
    ).Statement;
    expect(list!.Condition).toEqual({
      StringLike: { 's3:prefix': ['shop/2025/*'] },
    });
    expect(get!.Resource).toBe('arn:aws:s3:::acme-exports/shop/2025/*');
  });

  test('the whole bucket has no listing condition', () => {
    const [list, get] = read(
      permissionPolicy({ bucket: 'open-data', prefix: '' }),
    ).Statement;
    expect(list).toEqual({
      Effect: 'Allow',
      Action: 's3:ListBucket',
      Resource: 'arn:aws:s3:::open-data',
    });
    expect(get!.Resource).toBe('arn:aws:s3:::open-data/*');
  });
});

test('rolePolicies is both documents for one connection', () => {
  const both = rolePolicies({
    ...TRUST,
    bucket: 'acme-finance-lake',
    prefix: 'exports/',
  });
  expect(both.trust).toBe(trustPolicy(TRUST));
  expect(both.permission).toBe(
    permissionPolicy({ bucket: 'acme-finance-lake', prefix: 'exports/' }),
  );
});

test('the documents are written with two-space indent, as the console shows them', () => {
  const text = trustPolicy(TRUST);
  expect(
    text.startsWith('{\n  "Version": "2012-10-17",\n  "Statement": [\n'),
  ).toBe(true);
});

test('the account is read off an ARN, in any partition', () => {
  expect(accountOf(TRUST.principal)).toBe('111122223333');
  expect(accountOf(' arn:aws-cn:iam::210987654321:role/path/uno-read ')).toBe(
    '210987654321',
  );
  expect(accountOf('arn:aws:s3:::acme-exports')).toBeUndefined();
  expect(accountOf('uno-engine')).toBeUndefined();
  expect(accountOf('')).toBeUndefined();
});

test("a role's name is what follows its path", () => {
  expect(roleNameOf('arn:aws:iam::210987654321:role/uno-read')).toBe(
    'uno-read',
  );
  expect(roleNameOf('arn:aws:iam::210987654321:role/finance/eu/uno-read')).toBe(
    'uno-read',
  );
  expect(roleNameOf('uno-read')).toBe('uno-read');
});
