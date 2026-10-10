/**
 * @fileoverview Runs this folder's scripts in processes of their own, and
 * reads the JSON lines they print.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CORE = fileURLToPath(new URL('../../../', import.meta.url));
const PATHS = fileURLToPath(new URL('../../../../paths.js', import.meta.url));

/** Node flags that run this lab's TypeScript with the alias map. */
export const NODE_FLAGS: readonly string[] = [
  '--disable-warning=ExperimentalWarning',
  '--import',
  PATHS,
];

/** Characters of a process's stderr kept, to tell how it ended. */
const STDERR_TAIL = 2000;

/**
 * start runs `script` from this folder under node, from core/. A heap limit,
 * when given, is passed as --max-old-space-size.
 */
export function start(
  script: string,
  args: readonly string[],
  heapLimitMB?: number,
): ChildProcessWithoutNullStreams {
  const limit =
    heapLimitMB === undefined ? [] : [`--max-old-space-size=${heapLimitMB}`];
  return spawn(
    process.execPath,
    [...NODE_FLAGS, ...limit, join(HERE, script), ...args],
    { cwd: CORE },
  );
}

/** onLines calls `each` with every JSON line a process prints on stdout. */
export function onLines<T>(
  child: ChildProcessWithoutNullStreams,
  each: (line: T) => void,
): void {
  let pending = '';
  child.stdout.on('data', (d: Buffer) => {
    pending += d.toString();
    const lines = pending.split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith('{')) each(JSON.parse(line) as T);
    }
  });
}

/** stderrOf keeps the tail of a process's stderr and returns a reader for it. */
export function stderrOf(child: ChildProcessWithoutNullStreams): () => string {
  let tail = '';
  child.stderr.on('data', (d: Buffer) => {
    tail = (tail + d.toString()).slice(-STDERR_TAIL);
  });
  return () => tail;
}
