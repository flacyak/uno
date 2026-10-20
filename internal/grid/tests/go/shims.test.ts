// Tests for the Go standard library shims. Expected values were recorded from
// the equivalent Go calls.

import { describe, expect, test } from 'vite-plus/test';

import {
  findAllIndex,
  formatU,
  indexOfRunes,
  isZeroTime,
  parseTime,
  quoteMeta,
  replaceAllLiteral,
  rfc3339,
  sha256Hex,
} from '../../src/go/index.ts';

describe('quoteMeta', () => {
  const cases: Array<[string, string]> = [
    [',', ','],
    ['$', '\\$'],
    ['1,204', '1,204'],
    ['a.b+c', 'a\\.b\\+c'],
    ['[x]', '\\[x\\]'],
  ];

  for (const [input, want] of cases) {
    test(`${input} => ${want}`, () => {
      expect(quoteMeta(input)).toBe(want);
    });
  }

  test('what it escapes stays a valid pattern under the u flag', () => {
    for (const c of '\\.+*?()|[]{}^$') {
      expect(() => new RegExp(quoteMeta(c), 'u')).not.toThrow();
      expect(new RegExp(quoteMeta(c), 'u').test(c)).toBe(true);
    }
  });
});

describe('replaceAllLiteral', () => {
  test('takes the replacement as text, not as a template', () => {
    // String.replaceAll would expand $& and $1. Go keeps them as typed.
    expect(replaceAllLiteral(/x/u, 'axb', '$&')).toBe('a$&b');
    expect(replaceAllLiteral(/(a)/u, 'aa', '$1')).toBe('$1$1');
    expect(replaceAllLiteral(/,/u, '1,204,567', '')).toBe('1204567');
  });

  // An empty match at the position where the previous match ended is skipped,
  // as in Go. String.replace would give "--" and "#a##b#".
  test('an empty match abutting a previous match is not replaced twice', () => {
    expect(replaceAllLiteral(/a*/u, 'aaa', '-')).toBe('-');
    expect(replaceAllLiteral(/\d*/u, 'a12b', '#')).toBe('#a#b#');
    expect(replaceAllLiteral(/x*/u, 'abc', '-')).toBe('-a-b-c-');
    expect(replaceAllLiteral(/x*/u, 'a\u{1F600}b', '-')).toBe(
      '-a-\u{1F600}-b-',
    );
  });
});

describe('findAllIndex', () => {
  test('reports every match, in code points', () => {
    expect(findAllIndex(/,/u, '1,204,567')).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  // The empty match at 3 is dropped because it sits where the previous match
  // ended.
  test('handles empty matches the way Go does', () => {
    expect(findAllIndex(/x*/u, 'abxc')).toEqual([
      [0, 0],
      [1, 1],
      [2, 3],
      [4, 4],
    ]);
  });

  test('offsets are code points even past the BMP', () => {
    expect(findAllIndex(/,/u, '\u{1F600},a')).toEqual([[1, 2]]);
  });

  test('indexOfRunes', () => {
    expect(indexOfRunes('\u{1F600},a', ',')).toBe(1);
    expect(indexOfRunes('abc', 'z')).toBe(-1);
  });
});

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
