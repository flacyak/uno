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

/** One smoke check as it ran: how long it took, and whether it passed. */
export interface CheckTiming {
  name: string;
  ms: number;
  ok: boolean;
}

/** One step of a gate: what ran, how long it waited for a slot, how long it took. */
export interface StepTiming {
  step: string;
  wait: number;
  wall: number;
  status: number;
}

/** How many of the slowest files and checks a report names. */
const SLOWEST = 10;

/** A file's cost before its first test runs. */
const importOf = (f: FileTiming): number =>
  f.collect + f.setup + f.prepare + f.environment;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const table = (head: string[], rows: string[][]): string =>
  [head, head.map(() => '---'), ...rows]
    .map((r) => `| ${r.join(' | ')} |`)
    .join('\n');

/**
 * report lays out a gate's timings as markdown: each step, then the slowest
 * test files with their import and test time apart, then the slowest smoke
 * checks.
 */
export function report(
  steps: StepTiming[],
  files: FileTiming[],
  checks: CheckTiming[],
): string {
  const slowFiles = files
    .toSorted((a, b) => importOf(b) + b.tests - (importOf(a) + a.tests))
    .slice(0, SLOWEST);
  const slowChecks = checks.toSorted((a, b) => b.ms - a.ms).slice(0, SLOWEST);
  const inChecks = checks.reduce((sum, c) => sum + c.ms, 0);
  return [
    '## Steps',
    table(
      ['step', 'wait', 'wall', 'status'],
      steps.map((s) => [
        s.step,
        seconds(s.wait),
        seconds(s.wall),
        `${s.status}`,
      ]),
    ),
    `## Slowest test files (${files.length} files, ${seconds(files.reduce((sum, f) => sum + importOf(f), 0))} importing, ${seconds(files.reduce((sum, f) => sum + f.tests, 0))} in tests, summed over workers)`,
    table(
      ['file', 'import', 'tests'],
      slowFiles.map((f) => [f.file, seconds(importOf(f)), seconds(f.tests)]),
    ),
    `## Slowest smoke checks (${checks.length} checks, ${seconds(inChecks)} in checks, ${checks.filter((c) => !c.ok).length} failed)`,
    table(
      ['check', 'time'],
      slowChecks.map((c) => [c.name, seconds(c.ms)]),
    ),
  ].join('\n\n');
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
