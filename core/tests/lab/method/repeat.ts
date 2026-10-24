/**
 * @fileoverview Runs the performance suite N times, each in a `vp test` of
 * its own as the workflow runs it, and prints each metric's min, median and
 * spread across the runs. The spread is what one run of the workflow can be
 * off by with nothing changed.
 *
 * From core/:
 *
 *   node tests/lab/method/repeat.ts [--runs 10] [--tests tests/performance]
 *     [--tmp <dir>] [--cpus <list>] [--vitest-arg=<arg>]... [--out <file>]
 *
 * --tmp is handed to each run as TMPDIR, where the index test writes its
 * 96 MB file; on a machine whose /tmp is RAM, name a folder on disk to match
 * a GitHub runner. --cpus pins each run with taskset. --vitest-arg passes one
 * argument on to vitest, written with "=" because vitest's own arguments
 * start with "--".
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { spreads } from './aa.ts';
import { finish, fixed, machine, positiveInt, table, valuesOf } from './cli.ts';
import { summarize } from './stats.ts';
import {
  CORE_DIR,
  MS_PER_SECOND,
  PERFORMANCE_TESTS,
  runSuite,
} from './suite.ts';
import type { SuiteRun } from './suite.ts';

const DEFAULT_RUNS = 10;
const DEFAULT_OUT = join(CORE_DIR, 'out/lab/method-repeat.json');

const { values: flags } = parseArgs({
  options: {
    runs: { type: 'string', default: String(DEFAULT_RUNS) },
    tests: { type: 'string', multiple: true },
    tmp: { type: 'string' },
    cpus: { type: 'string' },
    'vitest-arg': { type: 'string', multiple: true },
    out: { type: 'string', default: DEFAULT_OUT },
  },
});

const runs = positiveInt(flags.runs, 'runs');
const tests = flags.tests ?? [PERFORMANCE_TESTS];
const vitestArgs = flags['vitest-arg'] ?? [];
const tmpRoot = flags.tmp ?? tmpdir();
const where = machine(tmpRoot);
const began = performance.now();

const tmpDir = mkdtempSync(join(tmpRoot, 'method-repeat-'));
const measured: SuiteRun[] = [];
try {
  for (let i = 0; i < runs; i++) {
    const run = await runSuite({ tests, vitestArgs, tmpDir, cpus: flags.cpus });
    console.error(`run ${i + 1} of ${runs}: ${fixed(run.seconds)} s`);
    measured.push(run);
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const metrics = spreads(measured.map((run) => valuesOf(run.metrics)));
console.log(
  table(
    [
      'metric',
      'unit',
      'min',
      'median',
      'max',
      'range %',
      'MAD %',
      'p95 pair %',
    ],
    Object.entries(metrics).map(([name, s]) => [
      name,
      s.unit,
      fixed(s.min),
      fixed(s.median),
      fixed(s.max),
      fixed(s.rangePct),
      fixed(s.madPct),
      fixed(s.p95AbsPairChangePct),
    ]),
  ),
);

finish(
  {
    name: 'method-repeat',
    runs,
    tests,
    cpus: flags.cpus ?? 'all',
    vitestArgs,
    machine: where,
    seconds: (performance.now() - began) / MS_PER_SECOND,
    runSeconds: summarize(measured.map((run) => run.seconds)),
    load1: summarize(measured.map((run) => run.load1)),
    metrics,
  },
  flags.out,
);
