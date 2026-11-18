import { expect, test } from 'vite-plus/test';
import type { ModuleDiagnostic } from 'vite-plus/test/node';

import { timingOf } from './timings.ts';

const MEASURED: ModuleDiagnostic = {
  environmentSetupDuration: 0.4,
  prepareDuration: 12.6,
  collectDuration: 480.2,
  setupDuration: 30.5,
  duration: 95.49,
  heap: undefined,
  importDurations: {},
};

test('a file timing rounds every cost to whole ms', () => {
  expect(timingOf('tests/engine/save.test.ts', MEASURED)).toEqual({
    file: 'tests/engine/save.test.ts',
    collect: 480,
    setup: 31,
    prepare: 13,
    environment: 0,
    tests: 95,
  });
});
