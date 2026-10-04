/**
 * @fileoverview Runs a suite once, the way the performance workflow does:
 * `vp test <tests>` from core/, in a process of its own. The run goes through
 * lab.config.ts, so its metrics are written to a folder made for this run and
 * read back from there, and core/out/ is left alone.
 */

import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OUT_ENV } from './record.ts';

/** core/, where the workflow runs `vp test`. */
export const CORE_DIR = fileURLToPath(new URL('../../../', import.meta.url));
/** The config every run is given, relative to core/. */
const LAB_CONFIG = 'tests/lab/method/lab.config.ts';
/** The command the workflow runs the suite with. */
const VP = 'vp';
/** util-linux's command for running a process on chosen CPUs. */
const TASKSET = 'taskset';
/** The suite the workflow measures. */
export const PERFORMANCE_TESTS = 'tests/performance';
/** How much of a failed run's output is kept for the error. */
const OUTPUT_TAIL_CHARS = 4000;
export const MS_PER_SECOND = 1000;

export interface SuiteOptions {
  /** Test files or folders, relative to core/. */
  readonly tests: readonly string[];
  /** Extra arguments for vitest, such as --no-file-parallelism. */
  readonly vitestArgs: readonly string[];
  /** TMPDIR for the run: where the index test writes its 96 MB file. */
  readonly tmpDir: string;
  /**
   * CPUs to pin the run to, as taskset takes them ("0,1,8,9"). Node reads
   * the pinned set as its parallelism, so vitest sizes its workers to it.
   */
  readonly cpus?: string | undefined;
}

/** The command and arguments that run `vp`, pinned when asked. */
function pinned(
  cpus: string | undefined,
  args: readonly string[],
): [string, string[]] {
  return cpus === undefined
    ? [VP, [...args]]
    : [TASKSET, ['--cpu-list', cpus, VP, ...args]];
}

/**
 * Recorded is a metric as read back from a file. Its unit is any string, so
 * a suite that adds a unit record.ts does not know yet is still read.
 */
export interface Recorded {
  readonly name: string;
  readonly unit: string;
  readonly value: number;
}

export interface SuiteRun {
  readonly metrics: readonly Recorded[];
  /** Wall time of the whole `vp test` process. */
  readonly seconds: number;
  /** The one-minute load average as the run started. */
  readonly load1: number;
}

function isRecorded(v: unknown): v is Recorded {
  if (typeof v !== 'object' || v === null) return false;
  return (
    'name' in v &&
    typeof v.name === 'string' &&
    'unit' in v &&
    typeof v.unit === 'string' &&
    'value' in v &&
    typeof v.value === 'number'
  );
}

/** Every metric written under `root`, by kind folder then file name. */
function metricsUnder(root: string): Recorded[] {
  const files = readdirSync(root)
    .toSorted()
    .filter((kind) => statSync(join(root, kind)).isDirectory())
    .flatMap((kind) =>
      readdirSync(join(root, kind))
        .filter((name) => name.endsWith('.json'))
        .toSorted()
        .map((name) => join(root, kind, name)),
    );
  return files.flatMap((file) => {
    const read: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(read) || !read.every(isRecorded)) {
      throw new Error(`${file} is not a list of metrics`);
    }
    return read;
  });
}

/** Runs a command to its end and returns its exit code and output. */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** runSuite runs the tests once and returns the metrics they recorded. */
export async function runSuite(options: SuiteOptions): Promise<SuiteRun> {
  const out = mkdtempSync(join(options.tmpDir, 'method-out-'));
  try {
    const load1 = loadavg()[0]!;
    const started = performance.now();
    const [command, args] = pinned(options.cpus, [
      'test',
      '--config',
      LAB_CONFIG,
      ...options.vitestArgs,
      ...options.tests,
    ]);
    const { code, output } = await run(command, args, CORE_DIR, {
      ...process.env,
      [OUT_ENV]: out,
      TMPDIR: options.tmpDir,
    });
    const seconds = (performance.now() - started) / MS_PER_SECOND;
    if (code !== 0) {
      throw new Error(`vp test exited with ${code}:\n${output}`);
    }
    const metrics = metricsUnder(out);
    if (metrics.length === 0) {
      throw new Error(`the run wrote no metrics under ${out}:\n${output}`);
    }
    return { metrics, seconds, load1 };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
