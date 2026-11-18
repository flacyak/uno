import { defineConfig } from 'vite-plus';

import { SlowestFirst } from './tests/sequencer.ts';
import { timingsReporter } from './tests/timings.ts';

/**
 * How long a test or a hook may take. A CI runner's disk can stall for a
 * minute, and a test of 40 ms then runs past the default 5 s. A hang still
 * fails, here.
 */
const TEST_BUDGET_MS = 30_000;

/** The test files that measure core, rather than check it. */
const MEASURED = ['tests/{lab,efficiency,performance}/**/*.test.ts'];
/** What vitest leaves out on its own, which an `exclude` of our own replaces. */
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'];

export default defineConfig({
  // The alias map in ../tsconfig.paths.json, for vitest.
  resolve: { tsconfigPaths: true },
  pack: {
    // One entry per package folder, plus five store modules imported on
    // their own. `exports: true` writes the subpath map into package.json
    // from these.
    // store/node is the only module that imports node:fs. store/s3 holds the
    // request signing code. store/sts holds the role assumption code.
    // store/metadata asks the host a process runs on for its role's keys.
    // store/otlp sends an engine's measurements to a collector.
    entry: [
      'src/index.ts',
      'src/*/index.ts',
      'src/store/metadata.ts',
      'src/store/node.ts',
      'src/store/otlp.ts',
      'src/store/s3.ts',
      'src/store/sts.ts',
    ],
    deps: { resolveDepSubpath: true },
    dts: {
      generator: 'tsgo',
    },
    exports: true,
  },
  test: {
    // Fails a test file that leaves a file handle open.
    setupFiles: ['tests/handles.ts'],
    // Writes what each file cost when UNO_TIMINGS names a folder.
    reporters: ['default', timingsReporter()],
    testTimeout: TEST_BUDGET_MS,
    hookTimeout: TEST_BUDGET_MS,
    // Starts the slowest file first across both projects, so the suite ends
    // when that file does.
    sequence: { sequencer: SlowestFirst },
    // Two projects, both run by `vp test`. The lab's research, the efficiency
    // budgets and the performance timings are 36 of core's 133 files and 241
    // of its 334 test seconds, one file 65 s on its own, and they measure the
    // engine, the index and ingest. `vp test --project core` runs the rest in
    // 25 s, for a change that touches none of those.
    projects: [
      {
        extends: true,
        test: { name: 'core', exclude: [...DEFAULT_EXCLUDE, ...MEASURED] },
      },
      { extends: true, test: { name: 'lab', include: MEASURED } },
    ],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'default-case': 'error',
    },
  },
  fmt: { singleQuote: true, printWidth: 80 },
});
