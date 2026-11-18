/**
 * @fileoverview Runs a full gate and writes where its time went.
 *
 *   node --import ../paths.js scripts/timings.ts [--out <folder>]
 *
 * The gate is check, the suite, a build and the smoke, each through
 * uno-bounded when that is on the PATH, as an agent runs them. Each step's
 * wall time is kept apart from the time it waited for a slot, taken as the
 * time before its first line of output that bounded did not print. The suite
 * runs with UNO_TIMINGS set, so every test file's cost is written, and the
 * smoke leaves every check's. All of it goes to <folder>, out/timings by
 * default: one log per step, the JSON, and timings.md, which names the
 * slowest files and checks.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { TIMINGS_VARIABLE, report } from '@core-tests/timings';
import type { CheckTiming, FileTiming, StepTiming } from '@core-tests/timings';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECKS = join(ROOT, 'apps/desktop/out/smoke/checks.json');
const STEPS = ['check', 'test', 'build', 'smoke'];
const BOUNDED = 'uno-bounded';

const { values } = parseArgs({
  options: { out: { type: 'string', default: join(ROOT, 'out/timings') } },
});
const out = values.out;
mkdirSync(out, { recursive: true });

/** Whether uno-bounded is on the PATH, so the gate queues as an agent's does. */
const bounded = (process.env['PATH'] ?? '')
  .split(delimiter)
  .some((dir) => dir !== '' && existsSync(join(dir, BOUNDED)));

/** step runs one gate step, logging its output to <out>/<step>.log. */
function step(name: string, env: NodeJS.ProcessEnv): Promise<StepTiming> {
  const args = ['run', name];
  const command = bounded ? [BOUNDED, '--', 'vp', ...args] : ['vp', ...args];
  const log = createWriteStream(join(out, `${name}.log`));
  const started = performance.now();
  let wait = 0;
  const saw = (chunk: Buffer): void => {
    log.write(chunk);
    const own = chunk
      .toString()
      .split('\n')
      .some((line) => line !== '' && !line.startsWith('bounded:'));
    if (wait === 0 && own) wait = performance.now() - started;
  };
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', saw);
    child.stderr.on('data', saw);
    child.on('close', (code) => {
      log.end();
      const wall = performance.now() - started;
      const status = code ?? 1;
      console.log(`${name}: ${(wall / 1000).toFixed(1)} s, status ${status}`);
      resolve({
        step: name,
        wait: Math.round(wait),
        wall: Math.round(wall),
        status,
      });
    });
  });
}

/** readJson reads a file the run wrote, or nothing when the step did not get there. */
function readJson<T>(path: string): T[] {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as T[])
    : [];
}

const tests = join(out, 'tests');
const steps: StepTiming[] = [];

/** write lays out what has run so far, so a gate stopped partway still reports. */
function write(): void {
  const files = ['core', 'desktop'].flatMap((pkg) =>
    readJson<FileTiming>(join(tests, `${pkg}.json`)).map((f) => ({
      ...f,
      file: `${pkg}/${f.file}`,
    })),
  );
  const checks = readJson<CheckTiming>(CHECKS);
  writeFileSync(
    join(out, 'timings.json'),
    JSON.stringify({ steps, files, checks }),
  );
  writeFileSync(join(out, 'timings.md'), report(steps, files, checks));
}

for (const name of STEPS) {
  steps.push(
    await step(name, name === 'test' ? { [TIMINGS_VARIABLE]: tests } : {}),
  );
  write();
}
console.log(`timings: ${join(out, 'timings.md')}`);
