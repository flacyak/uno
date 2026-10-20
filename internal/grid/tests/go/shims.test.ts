// Tests for the Go standard library shims. Expected values were recorded from
// the equivalent Go calls.

import { describe, expect, test } from 'vite-plus/test';

import { formatU, sha256Hex } from '../../src/go/index.ts';

describe('fmt and hashing', () => {
  test('formatU names a codepoint without printing it', () => {
    expect(formatU('√')).toBe('U+221A');
    expect(formatU('∑')).toBe('U+2211');
  });

  test('sha256Hex agrees with crypto/sha256', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
