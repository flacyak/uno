// Tests for document/hash.ts.

import { expect, test } from 'vite-plus/test';

import { sha256Hex } from '../../src/document/index.ts';

test('sha256Hex is the SHA-256 of the bytes as lower-case hex', () => {
  expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
