// Tests for the Go standard library shims. Expected values were recorded from
// the equivalent Go calls.

import { describe, expect, test } from 'vite-plus/test';

import {
  formatU,
  isZeroTime,
  parseTime,
  rfc3339,
  sha256Hex,
} from '../../src/go/index.ts';

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

  test('rfc3339 truncates to the second, as encoding/json does', () => {
    expect(rfc3339(new Date(Date.UTC(2026, 8, 9, 12, 0, 0)))).toBe(
      '2026-09-09T12:00:00Z',
    );
  });

  // Go's zero time.Time marshals as year 1. parseTime returns undefined for it
  // and for the Unix epoch, and isZeroTime is true for the epoch.
  test('the zero time.Time is year 1 and reads as absent, and so does the epoch', () => {
    expect(isZeroTime(parseTime('2026-09-09T12:00:00Z'))).toBe(false);
    expect(isZeroTime(new Date(0))).toBe(true);
    expect(parseTime('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(parseTime('1970-01-01T00:00:00Z')).toBeUndefined();
    expect(parseTime('garbage')).toBeUndefined();
    expect(parseTime('2026-09-09T12:00:00Z')?.toISOString()).toBe(
      '2026-09-09T12:00:00.000Z',
    );
  });
});
