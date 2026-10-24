/**
 * @fileoverview Run only by separate-outputs.test.ts through the method lab's
 * runSuite. Records one metric, the nonce it was handed, through the same
 * alias the performance tests import record from. Skipped when run directly.
 */

import { expect, test } from 'vite-plus/test';

import { record } from '@core-tests/efficiency/record';

const NONCE = process.env['PROBE_NONCE'];

test.skipIf(NONCE === undefined)('records the nonce it was handed', () => {
  // A probe run must never write to core/out/.
  expect(process.env['METHOD_OUT_DIR']).toBeDefined();
  record(
    'probe',
    [{ name: 'nonce', unit: 'x', value: Number(NONCE) }],
    'performance',
  );
});
