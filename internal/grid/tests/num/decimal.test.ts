// Tests for num/decimal.ts: the decimal forms a number is read from and written
// to. The expected values were recorded from the equivalent Go calls, which read
// and print the same forms.

import { describe, expect, test } from 'vite-plus/test';

import {
  atoi,
  formatFloat,
  parseFloat as goParseFloat,
  roundSignificant,
} from '../../src/num/index.ts';

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
