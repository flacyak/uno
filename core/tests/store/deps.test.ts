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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite-plus';
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

/** A module that loads another by a name made at run time. */
const LOADS = /\brequire\s*\(|\bgetBuiltinModule\b/;

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

/** What a module imports, re-exports or loads, as the names it gives. */
function names(url: string): string[] {
  const text = readFileSync(fileURLToPath(url), 'utf8');
  const { module } = parseSync(url, text);
  return [
    ...module.staticImports.map((i) => i.moduleRequest.value),
    ...module.staticExports.flatMap((e) =>
      e.entries.flatMap((x) => x.moduleRequest?.value ?? []),
    ),
    ...module.dynamicImports.map(({ moduleRequest: { start, end } }) =>
      text.slice(start, end).replace(/^(["'`])(.*)\1$/s, '$2'),
    ),
    ...(LOADS.test(text) ? ['require'] : []),
  ];
}

/** A module's path from the node_modules folder it is in. */
function shown(url: string): string {
  const at = '/node_modules/';
  return url.slice(url.lastIndexOf(at) + at.length);
}

/**
 * Every name the module `entry` resolves to reaches outside its own package,
 * following its relative imports, as `file: name`. A Node builtin is one, and
 * so is another package.
 */
function outward(entry: string): string[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  const next = [import.meta.resolve(entry)];
  for (let url = next.pop(); url !== undefined; url = next.pop()) {
    if (seen.has(url)) continue;
    seen.add(url);
    for (const name of names(url)) {
      if (name.startsWith('.')) next.push(new URL(name, url).href);
      else found.add(`${shown(url)}: ${name}`);
    }
  }
  return [...found].sort();
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

test('each entry reaches no Node builtin and no other package', () => {
  for (const entry of ENTRIES) expect(outward(entry), entry).toEqual([]);
});

// The walk is proved on the name the core avoids.
test("the walk finds the fs that hyparquet's bare name reaches", () => {
  expect(outward('hyparquet')).toEqual(['hyparquet/src/node.js: fs']);
});
