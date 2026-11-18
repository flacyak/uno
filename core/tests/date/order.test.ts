/**
 * @fileoverview inferOrder: which values decide a column's order, and when
 * none does.
 */

import { expect, test } from 'vite-plus/test';

import { inferOrder } from '@date';

test('a value that reads only one way decides the order', () => {
  const cases: Array<[string, string[], string | undefined]> = [
    ['13/04 is day first', ['03/04/2024', '13/04/2024'], 'day'],
    ['04/13 is month first', ['03/04/2024', '04/13/2024 09:30'], 'month'],
    ['neither decides', ['03/04/2024', '01-02-2024', '12.12.2024'], 'either'],
    ['both disagree', ['13/04/2024', '04/13/2024'], 'either'],
    ['ISO has none', ['2024-03-04', '2024-03-04 12:30', '2024-03'], undefined],
    ['month names have none', ['Mar 4, 2024', '04-Mar-2024'], undefined],
    ['ISO beside 13/04', ['2024-03-04', ' 13/04/2024 '], 'day'],
    ['not dates', ['13/13/2024', '1/2/24', 'West'], undefined],
    ['empty', [], undefined],
  ];
  for (const [name, values, order] of cases) {
    expect(inferOrder(values), name).toBe(order);
  }
});
