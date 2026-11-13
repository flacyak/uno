/**
 * @fileoverview The number a spreadsheet cell holds: what isNumber rejects,
 * what undress takes off, and what parse reads.
 */

import { describe, expect, test } from 'vite-plus/test';

import { isNumber, parse, undress } from '@num';

// isNumber accepts plain and accounting-style numbers and refuses the rest,
// including values Number() would accept.
describe('isNumber rejects what a spreadsheet does not mean', () => {
  for (const v of ['12', '-3.5', '+7', '1e3', '0.0', '1234.00-', '(1234.00)']) {
    test(`accepts ${JSON.stringify(v)}`, () => {
      expect(isNumber(v, 'point')).toBe(true);
    });
  }

  for (const v of [
    'inf',
    'NaN',
    '0x1p-2',
    '1,204',
    '',
    '12 ',
    '-',
    '()',
    '(-5)',
    '-5-',
    '(5',
    '5)',
    '(5)-',
    '1e400',
  ]) {
    test(`refuses ${JSON.stringify(v)}`, () => {
      expect(isNumber(v, 'point')).toBe(false);
    });
  }
});

// undress strips currency signs, thousands separators, percent signs and
// surrounding space. It keeps the decimal point and letters.
describe('undress takes off the costume and nothing else', () => {
  const cases: Array<[string, string]> = [
    ['1,204', '1204'],
    ['$1,204.50', '1204.50'],
    ['£40.00', '40.00'],
    ['€1 204', '1204'],
    ['12%', '12'],
    ["1'204", '1204'],
    [' 987 ', '987'],
    ['3.5', '3.5'],
    ['N/A', 'N/A'],
    ['', ''],
  ];

  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} => ${JSON.stringify(want)}`, () => {
      expect(undress(input, 'point')).toBe(want);
    });
  }
});

// parse undresses the value first, then reads it as a number.
describe('parse reads the number a person sees', () => {
  const cases: Array<[string, number | undefined]> = [
    ['12', 12],
    ['-3.5', -3.5],
    ['1,204', 1204],
    ['$1,204.50', 1204.5],
    ['£40.00', 40],
    [' 987 ', 987],

    // Whitespace at either edge is trimmed the same way column kind inference
    // trims it, including tab, CR and no-break space.
    ['12\t', 12],
    ['12\r', 12],
    ['\u00a012', 12],
    ['\t1,204\t', 1204],

    // A percent sign is stripped and the number keeps its written scale.
    ['12%', 12],

    // Accounting negatives: trailing minus sign or parentheses.
    ['1234.00-', -1234],
    ['(1234.00)', -1234],
    ['1,234.00-', -1234],
    ['$(1,234.00)', -1234],

    ['', undefined],
    ['N/A', undefined],
    ['inf', undefined],
    ['NaN', undefined],
    ['0x1p-2', undefined],
    ['1.2.3', undefined],
    ['12 ea', undefined],
  ];

  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} => ${want}`, () => {
      expect(parse(input, 'point')).toBe(want);
    });
  }
});

// With the comma mark, the comma is the decimal mark, and full stops and
// spaces separate thousands. A full stop anywhere but before a group of
// three digits refuses the value, so it is never read as a separator by
// mistake.
describe('parse reads a number written with the comma mark', () => {
  const cases: Array<[string, number | undefined]> = [
    ['1,5', 1.5],
    ['2,25', 2.25],
    ['1 234,5', 1234.5],
    ['1\u00a0234,5', 1234.5],
    ['1\u202f234,5', 1234.5],
    ['12,5%', 12.5],
    ['1,5e3', 1500],
    ['1 234,56 €', 1234.56],
    ['(1 234,56)', -1234.56],
    ['1 234,56-', -1234.56],
    ['1.234,56', 1234.56],
    ['1.234.567,8', 1234567.8],
    ['1.234', 1234],
    ['€1.234,56', 1234.56],
    ['(1.234,56)', -1234.56],

    ['1.5', undefined],
    ['1.2345', undefined],
    ['12.34,5', undefined],
    ['1,234.56', undefined],
    ['N/A', undefined],
    ['', undefined],
  ];

  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} => ${want}`, () => {
      expect(parse(input, 'comma')).toBe(want);
    });
  }
});

describe('isNumber with the comma mark refuses thousands separators', () => {
  test('a plain comma decimal is a number', () => {
    expect(isNumber('1,5', 'comma')).toBe(true);
  });
  test('a spaced one is not, until undress takes the space off', () => {
    expect(isNumber('1 234,5', 'comma')).toBe(false);
    expect(isNumber(undress('1 234,5', 'comma'), 'comma')).toBe(true);
  });
});
