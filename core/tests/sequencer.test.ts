import { expect, test } from 'vite-plus/test';
import type { TestSpecification, Vitest } from 'vite-plus/test/node';

import { SlowestFirst } from './sequencer.ts';

const ROOT = '/repo/core';
/** The last run's duration of each file, by vitest's cache key. */
const LAST_MS = new Map<string, number>([
  ['core:tests/quick.test.ts', 300],
  ['core:tests/slow.test.ts', 9_000],
  ['lab:tests/lab/slowest.test.ts', 57_000],
]);

/** Enough of a Vitest instance for the sequencer to read durations. */
const CTX = {
  config: { root: ROOT },
  cache: {
    getFileTestResults: (key: string) => {
      const duration = LAST_MS.get(key);
      return duration === undefined ? undefined : { duration, failed: false };
    },
    getFileStats: () => ({ size: 1 }),
  },
} as unknown as Vitest;

function spec(project: string, file: string): TestSpecification {
  const config = { sequence: { groupOrder: 0 }, isolate: true };
  return {
    project: { name: project, config },
    moduleId: `${ROOT}/${file}`,
  } as unknown as TestSpecification;
}

test('files start slowest first, and a file never run before them all', async () => {
  const sorted = await new SlowestFirst(CTX).sort([
    spec('core', 'tests/quick.test.ts'),
    spec('core', 'tests/slow.test.ts'),
    spec('lab', 'tests/lab/slowest.test.ts'),
    spec('lab', 'tests/lab/new.test.ts'),
  ]);
  expect(sorted.map((s) => s.moduleId.slice(ROOT.length + 1))).toEqual([
    'tests/lab/new.test.ts',
    'tests/lab/slowest.test.ts',
    'tests/slow.test.ts',
    'tests/quick.test.ts',
  ]);
});
