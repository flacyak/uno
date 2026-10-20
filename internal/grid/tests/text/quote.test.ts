// Tests for text/quote.ts. The expected values were recorded from the
// equivalent Go calls, whose spelling of a quoted string this is.

import { describe, expect, test } from 'vite-plus/test';

import { quote, unquote } from '../../src/text/index.ts';

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
