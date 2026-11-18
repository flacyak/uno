import { expect, test } from 'vite-plus/test';
import type { ModuleDiagnostic } from 'vite-plus/test/node';

import { report, timingOf } from './timings.ts';

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

test('a report names each step, then the slowest files and checks', () => {
  const steps = [
    { step: 'check', wait: 0, wall: 5200, status: 0 },
    { step: 'test', wait: 31000, wall: 90100, status: 1 },
  ];
  const file = (file: string, collect: number, tests: number) => ({
    file,
    collect,
    setup: 0,
    prepare: 0,
    environment: 0,
    tests,
  });
  const files = [
    file('core/tests/a.test.ts', 100, 200),
    file('core/tests/slow.test.ts', 1000, 64000),
    file('desktop/tests/b.test.ts', 3000, 50),
  ];
  const checks = [
    { group: 'open', name: 'opened', ms: 200, ok: true },
    { group: 'refresh', name: 'reloaded', ms: 1065, ok: false },
  ];
  const md = report(steps, files, checks);
  expect(md).toContain('| test | 31.0 s | 90.1 s | 1 |');
  expect(md).toContain(
    '## Slowest test files (3 files, 4.1 s importing, 64.3 s in tests, summed over workers)',
  );
  // Slowest first, by import and tests together.
  expect(md.indexOf('slow.test.ts')).toBeLessThan(md.indexOf('b.test.ts'));
  expect(md.indexOf('b.test.ts')).toBeLessThan(md.indexOf('a.test.ts'));
  expect(md).toContain('| desktop/tests/b.test.ts | 3.0 s | 0.1 s |');
  expect(md).toContain(
    '## Slowest smoke checks (2 checks, 1.3 s in checks, 1 failed)',
  );
  expect(md.indexOf('| reloaded | 1.1 s |')).toBeLessThan(
    md.indexOf('| opened | 0.2 s |'),
  );
});
