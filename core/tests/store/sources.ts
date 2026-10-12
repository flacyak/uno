/**
 * @fileoverview The core's sources as text, for the guards that read them
 * rather than run them: opens.test.ts and deps.test.ts.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

/** The core's sources, by their path under src/. */
export function core(): Map<string, string> {
  return new Map(
    sources(SRC).map((file) => [
      relative(SRC, file).replace(/\\/g, '/'),
      readFileSync(file, 'utf8'),
    ]),
  );
}

/** The core with one line added to one file. */
export function plant(file: string, line: string): Map<string, string> {
  const files = core();
  const text = files.get(file);
  if (text === undefined) throw new Error(`there is no ${file} to plant in`);
  files.set(file, `${text}\n${line}\n`);
  return files;
}
