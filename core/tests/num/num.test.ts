/**
 * @fileoverview The number a spreadsheet cell holds: what isNumber rejects,
 * what undress takes off, and what parse reads.
 */

import { describe, expect, test } from 'vite-plus/test';

import { isNumber, markShown, parse, undress } from '@num';
import type { Mark } from '@num';
import { seeded } from '@core-tests/lab/cache/stats';
import { mainParse } from './main.ts';

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

describe('markShown names the decimal mark a value shows beyond doubt', () => {
  const cases: Array<[string, string | undefined]> = [
    ['1,5', 'comma'],
    ['2,25', 'comma'],
    ['1,2345', 'comma'],
    ['1.234,56', 'comma'],
    ['1.234.567', 'comma'],
    ['0.5', 'point'],
    ['1,234.56', 'point'],
    ['1,234,567', 'point'],
    ['1,234', undefined],
    ['1.234', undefined],
    ['12', undefined],
  ];

  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} => ${want}`, () => {
      expect(markShown(input)).toBe(want);
    });
  }
});

// parse reads a plain decimal on a fast path. It must return what the full
// path returns, bit for bit, for every value it takes and every one it hands
// on.
describe('parse reads a plain decimal as the full path does', () => {
  /** Random strings of the fast path's shape, and of shapes beside it. */
  const RANDOM = 200_000;
  /** The most digits a random value has on either side of its mark. */
  const DIGITS_AT_MOST = 20;
  /** The share of random values that are whole, and that are negative. */
  const WHOLE_SHARE = 0.2;
  const NEGATIVE_SHARE = 0.5;
  const MARKS: Mark[] = ['point', 'comma'];
  const NEAR = [
    '',
    '-',
    '.',
    ',',
    '-.5',
    '5.',
    '+5',
    '1e3',
    ' 5',
    '5 ',
    '1.234',
    '1,234',
    '1.234,5',
    '1,234.5',
    '(5)',
    '5-',
    '--5',
    '00012.50',
    '-0',
    '-0.0',
    '9'.repeat(400),
    '0.' + '0'.repeat(400) + '1',
    '9007199254740993',
    '0.1000000000000000055511151231257827',
  ];

  test('on values beside its shape', () => {
    for (const mark of MARKS)
      for (const v of NEAR)
        expect(parse(v, mark), `${mark} ${v}`).toBe(mainParse(v, mark));
  });

  test(`on ${RANDOM.toLocaleString('en-US')} random values of its shape`, () => {
    const random = seeded(1);
    const digits = () => {
      let out = String(Math.floor(random() * 10));
      const n = Math.floor(random() * DIGITS_AT_MOST);
      for (let i = 0; i < n; i++) out += String(Math.floor(random() * 10));
      return out;
    };
    const differ: string[] = [];
    for (let i = 0; i < RANDOM; i++) {
      const mark = MARKS[i % MARKS.length]!;
      const sign = random() < NEGATIVE_SHARE ? '-' : '';
      const point = mark === 'point' ? '.' : ',';
      const v =
        random() < WHOLE_SHARE
          ? sign + digits()
          : sign + digits() + point + digits();
      if (!Object.is(parse(v, mark), mainParse(v, mark)))
        differ.push(`${mark} ${v}`);
    }
    expect(differ).toEqual([]);
  });
});
