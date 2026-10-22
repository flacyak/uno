/**
 * @fileoverview Checks the method lab against PR #65's own code.
 *
 * pr-compare.ts is `git show origin/t3/performance-workflow:internal/grid/
 * tests/efficiency/compare.ts`, byte for byte. Its verdict is private, so the
 * Change column of the table markdown() prints is parsed back into a call.
 *
 * 1. rule.ts's verdict matches the PR's on edge cases and on random values.
 * 2. Every pair in out/lab/method.json, run through the PR's compare() and
 *    markdown(), gives the counts method.json reports.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { verdict } from '../../method/rule.ts';
import type { Call } from '../../method/rule.ts';
import { compare, markdown } from './pr-compare.ts';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const METHOD_JSON = fileURLToPath(
  new URL('../../../../out/lab/method.json', import.meta.url),
);

/** The call the PR's table prints for one metric. */
function prCall(
  unit: string,
  base: number | undefined,
  head: number | undefined,
): Call {
  const metric = 'm';
  const table = markdown(
    [{ name: metric, unit, base, head }],
    base !== undefined,
    'performance',
  );
  const row = table.split('\n').find((l) => l.startsWith(`| ${metric} |`));
  if (row === undefined) throw new Error(`no row in\n${table}`);
  const cells = row.split('|').map((c) => c.trim());
  const change = cells[cells.length - 2]!;
  if (change === 'new' || change === 'gone' || change === 'same') return change;
  if (change.startsWith('within noise')) return 'noise';
  if (change.startsWith('better')) return 'better';
  if (change.startsWith('worse')) return 'worse';
  throw new Error(`unknown change "${change}"`);
}

test('pr-compare.ts is the PR branch file, unchanged', () => {
  const pr = execFileSync(
    'git',
    [
      'show',
      'origin/t3/performance-workflow:internal/grid/tests/efficiency/compare.ts',
    ],
    { cwd: HERE, encoding: 'utf8' },
  );
  expect(readFileSync(`${HERE}pr-compare.ts`, 'utf8')).toBe(pr);
});

const UNITS = ['ms', 'x', 'bytes', 'requests', 'MS', 'ms '];
const EDGE = [
  undefined,
  0,
  -0,
  1,
  -1,
  -0.33,
  0.01,
  95,
  95.00000001,
  100,
  104.99999999,
  105,
  105.00000001,
  95.5,
  Number.MIN_VALUE,
  Infinity,
  -Infinity,
  NaN,
  1e308,
];

test('rule.ts matches the PR on every pair of edge values and units', () => {
  let checked = 0;
  for (const unit of UNITS) {
    for (const base of EDGE) {
      for (const head of EDGE) {
        expect(verdict(unit, base, head), `${unit} ${base} -> ${head}`).toBe(
          prCall(unit, base, head),
        );
        checked++;
      }
    }
  }
  expect(checked).toBe(UNITS.length * EDGE.length * EDGE.length);
});

/** A small, seeded generator so a failure can be replayed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const RANDOM_TIMEOUT_MS = 60_000;

test('rule.ts matches the PR on 30,000 random values near the 5% edge', () => {
  const rand = lcg(65);
  const cases = 30_000;
  const spread = 0.12;
  for (let i = 0; i < cases; i++) {
    const base = (rand() - 0.2) * 1000;
    const head = base * (1 + (rand() - 0.5) * spread);
    const unit = UNITS[i % UNITS.length]!;
    const want = prCall(unit, base, head);
    const got = verdict(unit, base, head);
    if (got !== want) {
      throw new Error(`${unit} ${base} -> ${head}: rule ${got}, PR ${want}`);
    }
  }
}, RANDOM_TIMEOUT_MS);

interface RunRecord {
  arm: string;
  role: 'head' | 'base';
  pair: number;
  values: Record<string, number>;
}
interface Judged {
  calls: Record<Call, number>;
}
interface Arm {
  pairs: number;
  tablesWithAClaim: number;
  metrics: Record<string, Judged>;
}
interface MethodJson {
  pairs: number;
  arms: Record<string, Arm>;
  runs: RunRecord[];
}

test('method.json counts match the PR code run on its own raw runs', () => {
  const data = JSON.parse(readFileSync(METHOD_JSON, 'utf8')) as MethodJson;
  const unitOf = (name: string): string => (name.endsWith(': ms') ? 'ms' : '');
  for (const [armName, arm] of Object.entries(data.arms)) {
    const runs = data.runs.filter((r) => r.arm === armName);
    expect(runs).toHaveLength(2 * data.pairs);
    const calls: Record<string, Record<string, number>> = {};
    let tables = 0;
    for (let pair = 0; pair < data.pairs; pair++) {
      const side = (role: string) => {
        const found = runs.filter((r) => r.role === role && r.pair === pair);
        expect(found).toHaveLength(1);
        return Object.entries(found[0]!.values).map(([name, value]) => ({
          name,
          unit: unitOf(name),
          value,
        }));
      };
      const head = side('head');
      const base = side('base');
      const changes = compare(base, head);
      let claimed = false;
      for (const c of changes) {
        const call = prCall(c.unit, c.base, c.head);
        calls[c.name] ??= {};
        calls[c.name]![call] = (calls[c.name]![call] ?? 0) + 1;
        if (call === 'better' || call === 'worse') claimed = true;
      }
      if (claimed) tables++;
    }
    expect(tables, armName).toBe(arm.tablesWithAClaim);
    for (const [name, judged] of Object.entries(arm.metrics)) {
      for (const [call, n] of Object.entries(judged.calls)) {
        expect(calls[name]?.[call] ?? 0, `${armName} ${name} ${call}`).toBe(n);
      }
    }
  }
});
