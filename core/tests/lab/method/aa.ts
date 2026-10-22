/**
 * @fileoverview An A/A comparison: one commit measured as "head" and again as
 * "base", judged by the workflow's own rule. Every better or worse it prints
 * is a false claim, because nothing changed.
 *
 * Two orders are compared. `sequential` is the workflow's: every head run,
 * then every base run, so anything that drifts over the job lands on one
 * side. `interleaved` alternates head and base, so drift lands on both.
 */

import { claimed, verdict } from './rule.ts';
import type { Call } from './rule.ts';
import {
  PERCENT,
  changePct,
  median,
  pairwiseAbsChangePct,
  quantile,
  summarize,
} from './stats.ts';
import type { Summary } from './stats.ts';

export type Order = 'sequential' | 'interleaved';
export const ORDERS: readonly Order[] = ['sequential', 'interleaved'];

export type Role = 'head' | 'base';

/** Slot is one run in an arm: which side it is and which pair it is in. */
export interface Slot {
  readonly role: Role;
  readonly pair: number;
}

/** schedule lists an arm's runs in the order they are made. */
export function schedule(order: Order, pairs: number): Slot[] {
  const indices = Array.from({ length: pairs }, (_, pair) => pair);
  switch (order) {
    case 'sequential':
      return [
        ...indices.map((pair) => ({ role: 'head' as const, pair })),
        ...indices.map((pair) => ({ role: 'base' as const, pair })),
      ];
    case 'interleaved':
      return indices.flatMap((pair) => [
        { role: 'head' as const, pair },
        { role: 'base' as const, pair },
      ]);
    default: {
      const never: never = order;
      throw new Error(`unknown order ${String(never)}`);
    }
  }
}

/** One measured value of a metric. */
export interface Measured {
  readonly unit: string;
  readonly value: number;
}

/** Values is one run's metrics by name. */
export type Values = ReadonlyMap<string, Measured>;

/** The quantile of A/A changes a threshold must clear to be wrong 5% of the time. */
const FALSE_CALL_QUANTILE = 0.95;

/** Spread is a metric's summary over runs of one configuration. */
export interface Spread extends Summary {
  readonly unit: string;
  /**
   * The 95th percentile of |change| between any two runs, in percent: the
   * threshold a single-run comparison would need to be fooled one time in
   * twenty here.
   */
  readonly p95AbsPairChangePct: number;
}

/** spreads summarizes each metric over a set of runs of one commit. */
export function spreads(runs: readonly Values[]): Record<string, Spread> {
  const byName = new Map<string, { unit: string; values: number[] }>();
  for (const run of runs) {
    for (const [name, m] of run) {
      const entry = byName.get(name) ?? { unit: m.unit, values: [] };
      entry.values.push(m.value);
      byName.set(name, entry);
    }
  }
  const out: Record<string, Spread> = {};
  for (const [name, { unit, values }] of byName) {
    const pairs = pairwiseAbsChangePct(values);
    out[name] = {
      unit,
      ...summarize(values),
      p95AbsPairChangePct:
        pairs.length === 0 ? 0 : quantile(pairs, FALSE_CALL_QUANTILE),
    };
  }
  return out;
}

/** Judged is what the rule said about one metric over every pair of an arm. */
export interface Judged {
  readonly unit: string;
  readonly calls: Record<Call, number>;
  /** Pairs called better or worse, in percent of pairs. */
  readonly claimedPct: number;
  /** The median of head's change from base, signed: drift shows here. */
  readonly medianChangePct: number;
  readonly maxAbsChangePct: number;
  /** The rule on the quickest head beside the quickest base. */
  readonly pooledMin: Call;
  /** The rule on the median head beside the median base. */
  readonly pooledMedian: Call;
}

/** ArmVerdict is an arm's A/A result. */
export interface ArmVerdict {
  readonly pairs: number;
  /** Pairs whose table claimed at least one change. */
  readonly tablesWithAClaim: number;
  readonly metrics: Record<string, Judged>;
}

function noCalls(): Record<Call, number> {
  return { new: 0, gone: 0, same: 0, better: 0, worse: 0, noise: 0 };
}

/** judge applies the rule to head[i] beside base[i] for every pair. */
export function judge(
  heads: readonly Values[],
  bases: readonly Values[],
): ArmVerdict {
  if (heads.length !== bases.length || heads.length === 0) {
    throw new Error(`${heads.length} heads cannot pair ${bases.length} bases`);
  }
  const names = [
    ...new Set([...heads, ...bases].flatMap((run) => [...run.keys()])),
  ];
  const claimedIn = new Set<number>();
  const metrics: Record<string, Judged> = {};
  for (const name of names) {
    const calls = noCalls();
    const changes: number[] = [];
    let unit = '';
    heads.forEach((head, pair) => {
      const h = head.get(name);
      const b = bases[pair]!.get(name);
      unit = h?.unit ?? b?.unit ?? unit;
      const call = verdict(unit, b?.value, h?.value);
      calls[call]++;
      if (claimed(call)) claimedIn.add(pair);
      if (h !== undefined && b !== undefined) {
        changes.push(changePct(b.value, h.value));
      }
    });
    const headValues = heads.flatMap((r) => r.get(name)?.value ?? []);
    const baseValues = bases.flatMap((r) => r.get(name)?.value ?? []);
    const pooled = (pick: (v: number[]) => number): Call =>
      verdict(
        unit,
        baseValues.length === 0 ? undefined : pick(baseValues),
        headValues.length === 0 ? undefined : pick(headValues),
      );
    metrics[name] = {
      unit,
      calls,
      claimedPct: ((calls.better + calls.worse) / heads.length) * PERCENT,
      medianChangePct: changes.length === 0 ? 0 : median(changes),
      maxAbsChangePct: Math.max(0, ...changes.map(Math.abs)),
      pooledMin: pooled((v) => Math.min(...v)),
      pooledMedian: pooled(median),
    };
  }
  return { pairs: heads.length, tablesWithAClaim: claimedIn.size, metrics };
}
