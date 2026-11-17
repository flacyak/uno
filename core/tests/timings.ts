/**
 * @fileoverview A reporter that writes what each test file cost.
 *
 * Both packages list it in their vite.config.ts. It writes nothing unless
 * UNO_TIMINGS names a folder; then every test file's costs go there as
 * <package folder>.json, core.json or desktop.json, for scripts/timings.ts at
 * the repository root to read.
 *
 * A file's cost is split the way vitest measures it: importing the file and
 * all it imports, importing the setup files, vitest's own harness, and the
 * tests themselves.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { ModuleDiagnostic, Reporter } from 'vite-plus/test/node';

/** The variable that names the folder to write into. */
export const TIMINGS_VARIABLE = 'UNO_TIMINGS';

/** What one test file cost, every figure in ms. */
export interface FileTiming {
  /** The file, relative to its package. */
  file: string;
  /** Importing the file and everything it imports, and collecting its tests. */
  collect: number;
  /** Importing the setup files. */
  setup: number;
  /** Vitest's own harness. */
  prepare: number;
  /** Starting the environment, happy-dom in the desktop. */
  environment: number;
  /** Every test and hook. */
  tests: number;
}

/** timingOf reads one file's costs out of vitest's measurements. */
export function timingOf(file: string, d: ModuleDiagnostic): FileTiming {
  return {
    file,
    collect: Math.round(d.collectDuration),
    setup: Math.round(d.setupDuration),
    prepare: Math.round(d.prepareDuration),
    environment: Math.round(d.environmentSetupDuration),
    tests: Math.round(d.duration),
  };
}

/** timingsReporter writes every file's timing once the run ends. */
export function timingsReporter(): Reporter {
  let root = process.cwd();
  return {
    onInit(vitest) {
      root = vitest.config.root;
    },
    onTestRunEnd(modules) {
      const folder = process.env[TIMINGS_VARIABLE];
      if (folder === undefined || folder === '') return;
      const timings = modules.map((m) =>
        timingOf(m.relativeModuleId, m.diagnostic()),
      );
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, `${basename(root)}.json`),
        JSON.stringify(timings),
      );
    },
  };
}
