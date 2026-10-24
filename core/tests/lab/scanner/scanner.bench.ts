/**
 * @fileoverview Times every scanner variant on every shape: 96 MB held in
 * memory, pushed in the engine's 8 MB chunks, a fresh scanner and RowIndex
 * per run, as the engine's index pass has.
 *
 * Each shape and variant runs in a child process of its own, so no variant
 * inherits another's JIT feedback. A child builds the shape, scans it once
 * untimed to sum every begin, then `warmup` times untimed and `samples`
 * times timed, and prints its times and the sum. The parent checks every
 * sum against RecordScanner's on the same shape, keeps the minimum and
 * median, and prints a table, then one JSON object as its last line, which
 * it also writes to core/out/lab/scanner.json.
 *
 * From core/:
 *   node --experimental-transform-types --import ../paths.js \
 *     tests/lab/scanner/scanner.bench.ts [--mb 96] [--samples 7] [--warmup 2]
 *     [--shapes a,b] [--variants a,b]
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { RowIndex, TUNING } from '@engine/rows';
import { BulkIndex } from './bulk.ts';
import type { Begin, Consumer } from './common.ts';
import { SHAPES, shapeNamed } from './shapes.ts';
import { BASELINE, VARIANTS, variantNamed } from './variants.ts';
import { CopyIntoWasm } from './wasm.ts';

/** The engine's chunk size, TUNING.chunkBytes, in KB: the default. */
const ENGINE_CHUNK_KB = 8 << 10;
const KB = 1024;
/** Bytes in a megabyte, as the report counts them. */
const MB = 1_000_000;
const MS_PER_SECOND = 1000;
/** The name the copy-only reference runs under in place of a variant. */
const COPY = 'copy-into-wasm';
/** Digits kept in the JSON. */
const DIGITS = 3;
/** Column widths of the printed table. */
const NAME_WIDTH = 12;
const CELL_WIDTH = 16;

const OUT_DIR = fileURLToPath(new URL('../../../out/lab/', import.meta.url));
const OUT_FILE = `${OUT_DIR}scanner.json`;

/** What a child reports for one shape and variant. */
interface ChildResult {
  readonly bytes: number;
  readonly records: number;
  /** The sum of every begin, which any lost or moved begin changes. */
  readonly checksum: number;
  readonly ms: number[];
}

/** One variant's numbers on one shape. */
interface Row {
  readonly variant: string;
  readonly minMs: number;
  readonly medianMs: number;
  /** MB/s at the minimum time. */
  readonly mbps: number;
  readonly mbpsMedian: number;
  /** RecordScanner's time over this variant's, at the minimum. */
  readonly speedup: number;
  readonly speedupMedian: number;
  readonly samplesMs: number[];
}

const { values } = parseArgs({
  options: {
    child: { type: 'boolean', default: false },
    shape: { type: 'string', default: '' },
    variant: { type: 'string', default: '' },
    mb: { type: 'string', default: '96' },
    samples: { type: 'string', default: '7' },
    warmup: { type: 'string', default: '2' },
    'chunk-kb': { type: 'string', default: String(ENGINE_CHUNK_KB) },
    shapes: { type: 'string', default: SHAPES.map((s) => s.name).join(',') },
    variants: {
      type: 'string',
      default: VARIANTS.map((v) => v.name).join(','),
    },
  },
});

const bytesWanted = Number(values.mb) * MB;
const samples = Number(values.samples);
const warmup = Number(values.warmup);
const chunkBytes = Number(values['chunk-kb']) * KB;

if (values.child) {
  process.stdout.write(
    `${JSON.stringify(child(values.shape, values.variant))}\n`,
  );
} else {
  parent();
}

/** consumerOf adapts a Begin to a Consumer that takes runs one at a time. */
function consumerOf(begin: Begin): Consumer {
  return {
    begin,
    many: (begins, count, base) => {
      for (let k = 0; k < count; k++) begin(base + begins[k]!);
    },
  };
}

/** scanAll pushes `data` through a fresh scanner in chunks of chunkBytes. */
function scanAll(
  variantName: string,
  comma: string,
  data: Uint8Array,
  consumer: Consumer,
): void {
  const scanner = variantNamed(variantName).make(comma, consumer);
  for (let at = 0; at < data.length; at += chunkBytes) {
    scanner.push(data.subarray(at, Math.min(at + chunkBytes, data.length)), at);
  }
}

/**
 * child times one variant on one shape.
 *
 * The timed runs report begins as the engine's index pass does: one at a
 * time to a RowIndex, or, for the bulk variants, in runs to a BulkIndex,
 * which builds the same blocks. A first, untimed run adds up every begin
 * instead, for the parent to check against RecordScanner: a closure that
 * keeps a running sum costs more per record than RowIndex.begin does, and
 * would hide much of the scan.
 */
function child(shapeName: string, variantName: string): ChildResult {
  const shape = shapeNamed(shapeName);
  const data = shape.build(bytesWanted);

  let records = 0;
  let checksum = 0;
  if (variantName !== COPY) {
    scanAll(
      variantName,
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
    if (variantName === COPY) {
      const copier = new CopyIntoWasm();
      for (let at = 0; at < data.length; at += chunkBytes) {
        copier.push(data.subarray(at, Math.min(at + chunkBytes, data.length)));
      }
    } else {
      scanAll(variantName, shape.comma, data, toIndex);
    }
    return performance.now() - started;
  };

  for (let i = 0; i < warmup; i++) run();
  const ms: number[] = [];
  for (let i = 0; i < samples; i++) ms.push(run());
  // A variant reports to one index or the other, never both.
  const counted = index.counted + bulk.counted;
  if (variantName !== COPY && counted !== records) {
    throw new Error(
      `${variantName}: the index counted ${counted} of ${records} records`,
    );
  }
  return { bytes: data.length, records, checksum, ms };
}

/** spawnChild runs one shape and variant in a fresh process. */
function spawnChild(shape: string, variant: string): ChildResult {
  const args = [
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
    '--chunk-kb',
    String(values['chunk-kb']),
  ];
  const done = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (done.status !== 0) {
    throw new Error(`${shape} / ${variant} failed:\n${done.stderr}`);
  }
  const lines = done.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as ChildResult;
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(x: number): number {
  return Number(x.toFixed(DIGITS));
}

function mbps(bytes: number, ms: number): number {
  return bytes / MB / (ms / MS_PER_SECOND);
}

/** geometricMean is the n-th root of the product of n numbers. */
function geometricMean(xs: readonly number[]): number {
  return Math.exp(xs.reduce((sum, x) => sum + Math.log(x), 0) / xs.length);
}

function parent(): void {
  const started = performance.now();
  const shapeNames = values.shapes.split(',').filter((s) => s !== '');
  // RecordScanner runs first on every shape, whether named or not: the
  // others are checked and timed against it.
  const others = values.variants
    .split(',')
    .filter((v) => v !== '' && v !== BASELINE);
  const variantNames = [BASELINE, ...others];

  const shapes = shapeNames.map((name) => {
    const shape = shapeNamed(name);
    const base = spawnChild(name, BASELINE);
    const baseMin = Math.min(...base.ms);
    const baseMedian = median(base.ms);
    const rowOf = (variant: string, r: ChildResult): Row => {
      const min = Math.min(...r.ms);
      const med = median(r.ms);
      return {
        variant,
        minMs: round(min),
        medianMs: round(med),
        mbps: round(mbps(r.bytes, min)),
        mbpsMedian: round(mbps(r.bytes, med)),
        speedup: round(baseMin / min),
        speedupMedian: round(baseMedian / med),
        samplesMs: r.ms.map(round),
      };
    };
    const rows: Row[] = [rowOf(BASELINE, base)];
    for (const variant of others) {
      const r = spawnChild(name, variant);
      if (r.records !== base.records || r.checksum !== base.checksum) {
        throw new Error(
          `${variant} on ${name}: ${r.records} records, checksum ${r.checksum}; ` +
            `RecordScanner: ${base.records}, ${base.checksum}`,
        );
      }
      rows.push(rowOf(variant, r));
    }
    return {
      name,
      about: shape.about,
      comma: shape.comma,
      bytes: base.bytes,
      records: base.records,
      rows,
    };
  });

  // The copy alone, on the first shape: its cost per byte is the same on all.
  const copyShape = shapeNames[0];
  const copy =
    copyShape === undefined || !others.some((v) => v.startsWith('wasm'))
      ? undefined
      : spawnChild(copyShape, COPY);

  const report = {
    suite: 'scanner',
    node: process.version,
    unit: 'MB/s with MB = 10^6 bytes; ms per scan of the whole shape',
    chunkBytes,
    samples,
    warmup,
    variants: VARIANTS.filter((v) => variantNames.includes(v.name)).map((v) => {
      const speedups = shapes.map(
        (s) => s.rows.find((r) => r.variant === v.name)!.speedup,
      );
      return {
        name: v.name,
        about: v.about,
        /** The geometric mean over the shapes of the speedup at the minimum. */
        meanSpeedup: round(geometricMean(speedups)),
        worstSpeedup: round(Math.min(...speedups)),
      };
    }),
    shapes,
    reference:
      copy === undefined
        ? undefined
        : {
            name: COPY,
            about:
              'copying the shape into wasm memory in 256 KB pieces, no scan',
            shape: copyShape,
            minMs: round(Math.min(...copy.ms)),
            medianMs: round(median(copy.ms)),
            mbps: round(mbps(copy.bytes, Math.min(...copy.ms))),
          },
    elapsedSeconds: round((performance.now() - started) / MS_PER_SECOND),
  };

  printTable(shapes, variantNames);
  // The file holds exactly the line printed last.
  const line = `${JSON.stringify(report)}\n`;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, line);
  process.stdout.write(line);
}

/** printTable prints MB/s at the minimum, and the speedup, per shape and variant. */
function printTable(
  shapes: ReadonlyArray<{ name: string; rows: readonly Row[] }>,
  variantNames: readonly string[],
): void {
  const head = [
    'shape'.padEnd(NAME_WIDTH),
    ...variantNames.map((v) => v.padStart(CELL_WIDTH)),
  ];
  const lines = [head.join('')];
  for (const shape of shapes) {
    const cells = variantNames.map((v) => {
      const row = shape.rows.find((r) => r.variant === v);
      if (row === undefined) return ''.padStart(CELL_WIDTH);
      return `${row.mbps.toFixed(0)} ${row.speedup.toFixed(2)}x`.padStart(
        CELL_WIDTH,
      );
    });
    lines.push([shape.name.padEnd(NAME_WIDTH), ...cells].join(''));
  }
  process.stdout.write(
    `MB/s at the fastest run, and speedup over ${BASELINE}\n${lines.join('\n')}\n`,
  );
}
