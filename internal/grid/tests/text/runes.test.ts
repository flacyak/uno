// Tests for text/runes.ts: code points, their order, classes and case. The
// expected values were recorded from the equivalent Go calls, which count and
// order the same way.

import { describe, expect, test } from 'vite-plus/test';

import {
  compareStrings,
  equalFold,
  isDigit,
  isLetter,
  isSpace,
  runeLen,
  runes,
  toLower,
  toUpper,
  trimSpace,
} from '../../src/text/index.ts';

describe('runes', () => {
  test('splits code points, not code units', () => {
    expect(runes('aé\u{1F600}')).toEqual(['a', 'é', '\u{1F600}']);
    expect(runeLen('\u{1F600}')).toBe(1);
    expect('\u{1F600}'.length).toBe(2); // JS length counts code units
  });
});

describe('compareStrings', () => {
  // Go compares by UTF-8 bytes, which is code point order. JavaScript's `<`
  // compares code units, where a surrogate pair sorts below U+E000.
  test('orders by code point, the way UTF-8 bytes do', () => {
    const privateUse = '\ue000';
    const astral = '\u{1F600}';
    expect(compareStrings(privateUse, astral)).toBe(-1);
    expect(privateUse < astral).toBe(false); // code unit order
  });

  test('agrees with the obvious answer everywhere else', () => {
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    expect(compareStrings('a', 'a')).toBe(0);
    expect(compareStrings('a', 'ab')).toBe(-1);
    expect(['total', 'base', 'left'].sort(compareStrings)).toEqual([
      'base',
      'left',
      'total',
    ]);
  });

  test('a prefix sorts first, and a cut surrogate pair sorts as its unit', () => {
    expect(compareStrings('ab', 'a')).toBe(1);
    expect(compareStrings('', 'a')).toBe(-1);
    expect(compareStrings('x\ud83d', 'x\u{1F600}')).toBe(-1);
    expect(compareStrings('\u{1F600}a', '\u{1F600}b')).toBe(-1);
    expect(compareStrings('\u{1F600}', '\u{1F600}')).toBe(0);
  });
});

describe('case mapping', () => {
  // Go uses simple case mapping: one rune in, one rune out. JavaScript's full
  // mapping changes the length for these runes.
  const cases: Array<[string, string, string]> = [
    ['ß', 'ß', 'ß'], // eszett: JS uppercases it to "SS"
    ['ﬁ', 'ﬁ', 'ﬁ'], // fi ligature: JS gives "FI"
    ['İ', 'İ', 'i'], // dotted capital I: JS lowercases to i + combining dot
    ['ǰ', 'ǰ', 'ǰ'],
    ['é', 'É', 'é'],
    ['istanbul', 'ISTANBUL', 'istanbul'],
  ];

  for (const [input, up, low] of cases) {
    test(`${JSON.stringify(input)} upper/lower`, () => {
      expect(toUpper(input)).toBe(up);
      expect(toLower(input)).toBe(low);
    });
  }

  test('never changes the rune count', () => {
    for (const [input] of cases) {
      expect(runeLen(toUpper(input))).toBe(runeLen(input));
      expect(runeLen(toLower(input))).toBe(runeLen(input));
    }
  });

  test('equalFold', () => {
    expect(equalFold('ABC', 'abc')).toBe(true);
    expect(equalFold('ABC', 'abd')).toBe(false);
  });
});

describe('unicode classes', () => {
  test('isLetter is category L, not [a-zA-Z]', () => {
    expect(isLetter('r')).toBe(true);
    expect(isLetter('é')).toBe(true);
    expect(isLetter('5')).toBe(false);
    expect(isLetter('_')).toBe(false);
  });

  test('isDigit is category Nd', () => {
    expect(isDigit('5')).toBe(true);
    expect(isDigit('٥')).toBe(true); // Arabic-Indic five
    expect(isDigit('a')).toBe(false);
  });

  test('isSpace is White_Space, which JS \\s is not', () => {
    expect(isSpace(' ')).toBe(true);
    expect(isSpace('\t')).toBe(true);
    expect(isSpace('\u0085')).toBe(true); // NEL is White_Space
    expect(isSpace('\u00a0')).toBe(true);
    expect(isSpace('\ufeff')).toBe(false); // BOM is outside White_Space
    expect(isSpace('x')).toBe(false);
  });

  test('trimSpace', () => {
    expect(trimSpace(' x')).toBe('x');
    expect(trimSpace('  a b  ')).toBe('a b');
    expect(trimSpace('y')).toBe('y');
    expect(trimSpace('\u00a0z\u00a0')).toBe('z'); // NBSP is trimmed
    expect(trimSpace('\u0085z\u0085')).toBe('z'); // NEL is trimmed
    expect(trimSpace('\ufeffz\ufeff')).toBe('\ufeffz\ufeff'); // BOM is kept
    expect(trimSpace('   ')).toBe('');
    expect(trimSpace('')).toBe('');
    expect(trimSpace(' \u{1F600} a \u{1F600} ')).toBe('\u{1F600} a \u{1F600}');
  });
});
