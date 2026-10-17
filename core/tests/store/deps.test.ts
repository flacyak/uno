/**
 * @fileoverview A guard on the packages the core reads Parquet and zstd
 * through: the core names each by one entry, and that entry reaches nothing
 * outside its own package, a Node builtin least of all.
 *
 * hyparquet's bare name is its Node entry, src/node.js, which imports fs. Its
 * src/index.js is the same reader without it, so that file is the name the
 * core uses. hyparquet-compressors compiles WASM when it is imported, so the
 * core never names it and builds its own page codecs.
 */

import { expect, test } from 'vite-plus/test';

import { core, plant } from './sources.ts';

/** The one name the core imports each package by. */
const ENTRIES: readonly string[] = ['hyparquet/src/index.js', 'fzstd'];

/**
 * One of the packages named as a string in any form, with any path after it:
 * `from`, a bare `import`, `import()` or `require()`. hyparquet-compressors
 * and hyparquet-writer match as other hyparquet names.
 */
const NAMED = /["'`]((?:hyparquet|fzstd)[^"'`]*)["'`]/g;

/** Every name of the packages in the core other than an entry, as `file: name`. */
function misnamed(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .flatMap(([file, text]) =>
      [...text.matchAll(NAMED)].map((m) => ({ file, name: m[1]! })),
    )
    .filter(({ name }) => !ENTRIES.includes(name))
    .map(({ file, name }) => `${file}: ${name}`)
    .sort();
}

test('the core names hyparquet and fzstd only by their entries', () => {
  expect(misnamed(core())).toEqual([]);
});

test('a planted name other than an entry fails it', () => {
  const plants: Array<[line: string, name: string]> = [
    ["import { parquetRead } from 'hyparquet';", 'hyparquet'],
    ['import { x } from "hyparquet/src/node.js";', 'hyparquet/src/node.js'],
    [
      "const { compressors } = await import('hyparquet-compressors');",
      'hyparquet-compressors',
    ],
    [
      "const { decompress } = require('fzstd/lib/index.js');",
      'fzstd/lib/index.js',
    ],
  ];
  for (const [line, name] of plants) {
    expect(misnamed(plant('ingest/format.ts', line)), line).toEqual([
      `ingest/format.ts: ${name}`,
    ]);
  }
});
