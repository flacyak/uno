// Tests for program/regexp.ts: the three places JavaScript's RegExp and the
// patterns a program stores disagree. The expected values were recorded from
// the equivalent Go calls, whose answers the program language keeps.

import { describe, expect, test } from 'vite-plus/test';

import {
  findAllIndex,
  indexOfRunes,
  quoteMeta,
  replaceAllLiteral,
} from '../../src/program/index.ts';

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
