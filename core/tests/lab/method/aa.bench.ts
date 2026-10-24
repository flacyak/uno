/**
 * @fileoverview The A/A benchmark: this commit against itself, judged by the
 * performance workflow's 5 percent rule, to count how often the rule claims
 * a change when there is none.
 *
 * Each arm makes --pairs head runs and --pairs base runs of the suite, every
 * one a `vp test` of its own as in the workflow:
 *
 *   sequential          every head run, then every base run, as the workflow
 *                       orders its two steps
 *   interleaved         head, base, head, base
 *   interleaved-serial  interleaved, with vitest running one test file at a
 *                       time (--no-file-parallelism) instead of all at once
 *
 * A pair shares a TMPDIR, as head and base share /tmp on a runner.
 *
 * From core/:
 *
 *   node tests/lab/method/aa.bench.ts [--pairs 8]
 *     [--arms sequential,interleaved,interleaved-serial]
 *     [--tests tests/performance] [--tmp <dir>] [--cpus <list>]
 *     [--vitest-arg=<arg>]... [--out out/lab/method.json]
 *
 * --cpus pins every run with taskset. On the Ryzen 7 2700X, 0,1,8,9 is two
 * cores and their SMT siblings, the shape of a 4-vCPU GitHub runner, and
 * vitest then starts 3 workers as it does there.
 *
 * Prints a table per arm, then the whole result as one JSON line, which is
 * also written to --out.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { judge, schedule, spreads } from './aa.ts';
import type { ArmVerdict, Order, Role, Spread, Values } from './aa.ts';
import { finish, fixed, machine, positiveInt, table, valuesOf } from './cli.ts';
import { CLOCK_UNIT, NOISE_FRACTION } from './rule.ts';
import { summarize } from './stats.ts';
import type { Summary } from './stats.ts';
import {
  CORE_DIR,
  MS_PER_SECOND,
  PERFORMANCE_TESTS,
  runSuite,
} from './suite.ts';

/** Arm is one way of ordering and running the pairs. */
interface Arm {
  readonly name: string;
  readonly order: Order;
  readonly vitestArgs: readonly string[];
}

const ARMS: readonly Arm[] = [
  { name: 'sequential', order: 'sequential', vitestArgs: [] },
  { name: 'interleaved', order: 'interleaved', vitestArgs: [] },
  {
    name: 'interleaved-serial',
    order: 'interleaved',
    vitestArgs: ['--no-file-parallelism'],
  },
];

/**
 * Eight pairs in each of three arms is 48 runs of 2.3 to 3.3 s each, a little
 * over two minutes on the Ryzen 7 2700X this was written on.
 */
const DEFAULT_PAIRS = 8;
const DEFAULT_OUT = join(CORE_DIR, 'out/lab/method.json');

/** RunRecord is one run as it is kept in the result. */
interface RunRecord {
  arm: string;
  role: Role;
  pair: number;
  seconds: number;
  load1: number;
  values: Record<string, number>;
}

/** ArmReport is everything one arm found. */
interface ArmReport extends ArmVerdict {
  order: Order;
  vitestArgs: readonly string[];
  runSeconds: Summary;
  load1: Summary;
  /** Each metric over every run of the arm, head and base together. */
  spread: Record<string, Spread>;
}

const { values: flags } = parseArgs({
  options: {
    pairs: { type: 'string', default: String(DEFAULT_PAIRS) },
    arms: { type: 'string', default: ARMS.map((a) => a.name).join(',') },
    tests: { type: 'string', multiple: true },
    tmp: { type: 'string' },
    cpus: { type: 'string' },
    'vitest-arg': { type: 'string', multiple: true },
    out: { type: 'string', default: DEFAULT_OUT },
  },
});

const pairs = positiveInt(flags.pairs, 'pairs');
const chosen = flags.arms.split(',').map((name) => {
  const arm = ARMS.find((a) => a.name === name);
  if (arm === undefined) {
    throw new Error(`--arms names ${ARMS.map((a) => a.name).join(', ')}`);
  }
  return arm;
});
const tests = flags.tests ?? [PERFORMANCE_TESTS];
const extraArgs = flags['vitest-arg'] ?? [];
const tmpRoot = flags.tmp ?? tmpdir();
const where = machine(tmpRoot);
const began = performance.now();

const runs: RunRecord[] = [];
const arms: Record<string, ArmReport> = {};

for (const arm of chosen) {
  const pairDirs = Array.from({ length: pairs }, (_, pair) =>
    mkdtempSync(join(tmpRoot, `method-${arm.name}-${pair}-`)),
  );
  const sides: Record<Role, Values[]> = { head: [], base: [] };
  const seconds: number[] = [];
  const loads: number[] = [];
  try {
    const slots = schedule(arm.order, pairs);
    for (const [at, { role, pair }] of slots.entries()) {
      const run = await runSuite({
        tests,
        vitestArgs: [...arm.vitestArgs, ...extraArgs],
        tmpDir: pairDirs[pair]!,
        cpus: flags.cpus,
      });
      sides[role][pair] = valuesOf(run.metrics);
      seconds.push(run.seconds);
      loads.push(run.load1);
      runs.push({
        arm: arm.name,
        role,
        pair,
        seconds: run.seconds,
        load1: run.load1,
        values: Object.fromEntries(run.metrics.map((m) => [m.name, m.value])),
      });
      console.error(
        `${arm.name} ${at + 1}/${slots.length}: ${role} ${pair}, ${fixed(run.seconds)} s`,
      );
    }
  } finally {
    for (const dir of pairDirs) rmSync(dir, { recursive: true, force: true });
  }
  arms[arm.name] = {
    order: arm.order,
    vitestArgs: [...arm.vitestArgs, ...extraArgs],
    runSeconds: summarize(seconds),
    load1: summarize(loads),
    spread: spreads([...sides.head, ...sides.base]),
    ...judge(sides.head, sides.base),
  };
}

for (const [name, arm] of Object.entries(arms)) {
  console.log(
    `\n${name}: ${arm.tablesWithAClaim} of ${arm.pairs} tables claim a change`,
  );
  console.log(
    table(
      [
        'metric',
        'min',
        'median',
        'range %',
        'p95 pair %',
        'claimed',
        'median change %',
        'max |change| %',
        'min vs min',
        'median vs median',
      ],
      Object.entries(arm.metrics).map(([metric, j]) => {
        const s = arm.spread[metric];
        return [
          metric,
          s === undefined ? '' : fixed(s.min),
          s === undefined ? '' : fixed(s.median),
          s === undefined ? '' : fixed(s.rangePct),
          s === undefined ? '' : fixed(s.p95AbsPairChangePct),
          `${j.calls.better + j.calls.worse}/${arm.pairs}`,
          fixed(j.medianChangePct),
          fixed(j.maxAbsChangePct),
          j.pooledMin,
          j.pooledMedian,
        ];
      }),
    ),
  );
}

finish(
  {
    name: 'method',
    pairs,
    tests,
    cpus: flags.cpus ?? 'all',
    rule: { clockUnit: CLOCK_UNIT, noiseFraction: NOISE_FRACTION },
    machine: where,
    seconds: (performance.now() - began) / MS_PER_SECOND,
    arms,
    runs,
  },
  flags.out,
);
