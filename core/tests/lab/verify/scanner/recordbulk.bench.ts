/**
 * @fileoverview Times the bulk handoff alone, in JS: RecordScanner's byte
 * loop unchanged, begins handed to BulkIndex.beginMany in runs of 4096,
 * against RecordScanner feeding RowIndex one begin at a time. The wasm bulk
 * variants run beside them for a same-session reference.
 *
 * Same method as ../../scanner/scanner.bench.ts: each shape and variant in a
 * child process, the shape built in memory, 8 MB chunks, one untimed
 * checksum run, `warmup` untimed runs, `samples` timed runs, a fresh scanner
 * and index per run, and every checksum checked against RecordScanner's.
 *
 * From core/, alone on a quiet machine:
 *   node --experimental-transform-types --import ../paths.js \
 *     tests/lab/verify/scanner/recordbulk.bench.ts [--mb 96] [--samples 7]
 *     [--warmup 2] [--cold]
 *
 * --cold measures what a fresh engine process pays on its first scan: no
 * checksum run and no warm-up, one timed run per process, repeated
 * `samples` times in fresh processes. Begins are then checked by count only.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { RowIndex, TUNING } from '@engine/rows';
import { BulkIndex } from '../../scanner/bulk.ts';
import type { Begin, Consumer, LabScanner } from '../../scanner/common.ts';
import { SHAPES, shapeNamed } from '../../scanner/shapes.ts';
import { variantNamed } from '../../scanner/variants.ts';
import { RecordBulkScanner } from './recordbulk.ts';

const MB = 1_000_000;
const DIGITS = 3;
const NAME_WIDTH = 12;
const CELL_WIDTH = 20;
const BASELINE = 'record';
const VARIANTS = [
  BASELINE,
  'record-bulk',
  'swar-bulk',
  'wasm-bulk',
  'wasm-blocks-bulk',
] as const;

const { values } = parseArgs({
  options: {
    child: { type: 'boolean', default: false },
    shape: { type: 'string', default: '' },
    variant: { type: 'string', default: '' },
    mb: { type: 'string', default: '96' },
    samples: { type: 'string', default: '7' },
    warmup: { type: 'string', default: '2' },
    cold: { type: 'boolean', default: false },
  },
});
const bytesWanted = Number(values.mb) * MB;
const samples = Number(values.samples);
const warmup = Number(values.warmup);
const chunkBytes = TUNING.chunkBytes;

interface ChildResult {
  readonly bytes: number;
  readonly records: number;
  readonly checksum: number;
  readonly ms: number[];
}

function make(name: string, comma: string, consumer: Consumer): LabScanner {
  if (name === 'record-bulk')
    return new RecordBulkScanner(comma, consumer.many);
  return variantNamed(name).make(comma, consumer);
}

function consumerOf(begin: Begin): Consumer {
  return {
    begin,
    many: (begins, count, base) => {
      for (let k = 0; k < count; k++) begin(base + begins[k]!);
    },
  };
}

function scanAll(
  name: string,
  comma: string,
  data: Uint8Array,
  consumer: Consumer,
): void {
  const scanner = make(name, comma, consumer);
  for (let at = 0; at < data.length; at += chunkBytes) {
    scanner.push(data.subarray(at, Math.min(at + chunkBytes, data.length)), at);
  }
}

function child(shapeName: string, name: string): ChildResult {
  const shape = shapeNamed(shapeName);
  const data = shape.build(bytesWanted);
  let records = 0;
  let checksum = 0;
  if (!values.cold) {
    scanAll(
      name,
      shape.comma,
      data,
      consumerOf((offset) => {
        records++;
        checksum += offset;
      }),
    );
  }
  let index = new RowIndex(0, data.length, TUNING);
  let bulk = new BulkIndex(TUNING);
  const toIndex: Consumer = {
    begin: (offset) => index.begin(offset),
    many: (begins, count, base) => bulk.beginMany(begins, count, base),
  };
  const run = (): number => {
    index = new RowIndex(0, data.length, TUNING);
    bulk = new BulkIndex(TUNING);
    const started = performance.now();
    scanAll(name, shape.comma, data, toIndex);
    return performance.now() - started;
  };
  for (let i = 0; i < warmup; i++) run();
  const ms: number[] = [];
  for (let i = 0; i < samples; i++) ms.push(run());
  if (values.cold) records = index.counted + bulk.counted;
  if (index.counted + bulk.counted !== records) {
    throw new Error(`${name}: the index counted the wrong number of records`);
  }
  return { bytes: data.length, records, checksum, ms };
}

function spawnChild(shape: string, variant: string): ChildResult {
  if (!values.cold) return spawnOne(shape, variant, samples, warmup);
  // One run per fresh process, `samples` processes.
  const runs = Array.from({ length: samples }, () =>
    spawnOne(shape, variant, 1, 0),
  );
  return { ...runs[0]!, ms: runs.map((r) => r.ms[0]!) };
}

function spawnOne(
  shape: string,
  variant: string,
  samples: number,
  warmup: number,
): ChildResult {
  const done = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      '--child',
      '--shape',
      shape,
      '--variant',
      variant,
      '--mb',
      String(values.mb),
      '--samples',
      String(samples),
      '--warmup',
      String(warmup),
      ...(values.cold ? ['--cold'] : []),
    ],
    { encoding: 'utf8' },
  );
  if (done.status !== 0)
    throw new Error(`${shape}/${variant}:\n${done.stderr}`);
  const lines = done.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as ChildResult;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

if (values.child) {
  process.stdout.write(
    `${JSON.stringify(child(values.shape, values.variant))}\n`,
  );
} else {
  const report = SHAPES.map((shape) => {
    const base = spawnChild(shape.name, BASELINE);
    const baseMedian = median(base.ms);
    const rows = VARIANTS.map((variant) => {
      const r = variant === BASELINE ? base : spawnChild(shape.name, variant);
      if (r.records !== base.records || r.checksum !== base.checksum) {
        throw new Error(`${variant} on ${shape.name}: begins differ`);
      }
      const med = median(r.ms);
      return {
        variant,
        medianMs: Number(med.toFixed(DIGITS)),
        speedupMedian: Number((baseMedian / med).toFixed(DIGITS)),
        samplesMs: r.ms.map((x) => Number(x.toFixed(DIGITS))),
      };
    });
    return {
      shape: shape.name,
      bytes: base.bytes,
      records: base.records,
      rows,
    };
  });
  const head = [
    'shape'.padEnd(NAME_WIDTH),
    ...VARIANTS.map((v) => v.padStart(CELL_WIDTH)),
  ];
  const lines = [head.join('')];
  for (const s of report) {
    lines.push(
      [
        s.shape.padEnd(NAME_WIDTH),
        ...s.rows.map((r) =>
          `${r.medianMs.toFixed(1)} ${r.speedupMedian.toFixed(2)}x`.padStart(
            CELL_WIDTH,
          ),
        ),
      ].join(''),
    );
  }
  process.stdout.write(
    `median ms, and speedup over ${BASELINE}\n${lines.join('\n')}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ suite: 'verify-scanner-recordbulk', node: process.version, samples, warmup, chunkBytes, report })}\n`,
  );
}
