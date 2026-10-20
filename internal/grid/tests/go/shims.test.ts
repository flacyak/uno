// Tests for the Go standard library shims. Expected values were recorded from
// the equivalent Go calls.

import { describe, expect, test } from 'vite-plus/test';

import {
  atoi,
  findAllIndex,
  formatFloat,
  formatU,
  indexOfRunes,
  isZeroTime,
  parseFloat as goParseFloat,
  parseTime,
  quote,
  quoteMeta,
  replaceAllLiteral,
  rfc3339,
  roundSignificant,
  sha256Hex,
  unquote,
} from '../../src/go/index.ts';

describe('formatFloat', () => {
  // Matches strconv.FormatFloat(v, 'f', -1, 64): shortest round-trip form,
  // always in plain decimal.
  const cases: Array<[number, string]> = [
    [0.22, '0.22'],
    [0.21999999999999997, '0.21999999999999997'],
    [1e21, '1000000000000000000000'],
    [1e-7, '0.0000001'],
    [1.5e-10, '0.00000000015'],
    [123456789012345680000, '123456789012345680000'],
    [0, '0'],
    [-1.5, '-1.5'],
  ];

  for (const [v, want] of cases) {
    test(`${v} => ${want}`, () => {
      expect(formatFloat(v)).toBe(want);
    });
  }

  test('1e300 prints 301 digits rather than an exponent', () => {
    const got = formatFloat(1e300);
    expect(got).toBe('1' + '0'.repeat(300));
    expect(got).not.toContain('e');
  });

  test('keeps the sign of a negative zero, as Go does', () => {
    expect(formatFloat(-0)).toBe('-0');
    expect((-0).toString()).toBe('0'); // JS drops the sign
  });
});

describe('roundSignificant', () => {
  // Rounds to the significant digits a computed cell keeps.
  const DIGITS = 15;

  const cases: Array<[number, string]> = [
    [(40.0 - 31.2) / 40.0, '0.22'],
    [1 / 3, '0.333333333333333'],
    [2 / 3, '0.666666666666667'],
  ];

  for (const [v, want] of cases) {
    test(`${v} => ${want}`, () => {
      expect(formatFloat(roundSignificant(v, DIGITS))).toBe(want);
    });
  }

  test('leaves an infinity alone rather than throwing', () => {
    expect(roundSignificant(Infinity, DIGITS)).toBe(Infinity);
  });
});

describe('quote', () => {
  const cases: Array<[string, string]> = [
    ['a', '"a"'],
    ['a"b', '"a\\"b"'],
    ['a\\b', '"a\\\\b"'],
    ['tab\there', '"tab\\there"'],
    ['é', '"é"'], // printable runes are left as is
    ['1,204', '"1,204"'],
    ['', '""'],
    ['nl\n', '"nl\\n"'],
    ['\u0007', '"\\a"'],
    ['\u0000', '"\\x00"'],
    ['€', '"€"'],
  ];

  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} => ${want}`, () => {
      expect(quote(input)).toBe(want);
    });
  }
});

describe('unquote', () => {
  const cases: Array<[string, string]> = [
    ['"a\\tb"', 'a\tb'],
    ['"\\x41"', 'A'],
    ['"€"', '€'],
    ['"$1"', '$1'],
    ['"\\101"', 'A'],
    ['"\\u00e9"', 'é'],
    ['""', ''],
  ];

  for (const [input, want] of cases) {
    test(`${input} => ${JSON.stringify(want)}`, () => {
      expect(unquote(input)).toBe(want);
    });
  }

  test('refuses what Go refuses', () => {
    expect(() => unquote('"a')).toThrow();
    expect(() => unquote('"\\q"')).toThrow();
    expect(() => unquote('"\\x4"')).toThrow();
  });

  test('round-trips through quote', () => {
    for (const s of ['', 'a', 'a"b', 'a\\b', '\t', '1,204', '€', '$1']) {
      expect(unquote(quote(s))).toBe(s);
    }
  });
});

describe('parseFloat', () => {
  test('reads what Go reads', () => {
    expect(goParseFloat('12')).toBe(12);
    expect(goParseFloat('+7')).toBe(7);
    expect(goParseFloat('-1.5')).toBe(-1.5);
    expect(goParseFloat('1e3')).toBe(1000);
    expect(goParseFloat('.5')).toBe(0.5);
  });

  test('refuses what Number() would have accepted', () => {
    expect(goParseFloat('')).toBeUndefined();
    expect(goParseFloat('0x10')).toBeUndefined();
    expect(goParseFloat('Infinity')).toBeUndefined();
    expect(goParseFloat(' 12 ')).toBeUndefined();
    expect(goParseFloat('1.2.3')).toBeUndefined();
  });

  // Matches strconv.ParseFloat: a value too large for a float64 is an error
  // (undefined here), and a value too small is 0.
  test('refuses a decimal that overflows, as Go does', () => {
    expect(goParseFloat('1e400')).toBeUndefined();
    expect(goParseFloat('-1e400')).toBeUndefined();
    expect(goParseFloat('1e-400')).toBe(0);
  });

  test('atoi is whole numbers only', () => {
    expect(atoi('12')).toBe(12);
    expect(atoi('-3')).toBe(-3);
    expect(atoi('1.5')).toBeUndefined();
    expect(atoi('')).toBeUndefined();
  });
});

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
