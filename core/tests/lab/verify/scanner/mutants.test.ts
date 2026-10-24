/**
 * @fileoverview The checks of exact.test.ts have teeth: each mutated build of
 * scan.c in build/ (made by hand with zig, see the report) disagrees with
 * RecordScanner on the exhaustive boundary strings, and the unmutated
 * rebuild agrees.
 */

import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { BaselineScanner } from '../../scanner/baseline.ts';
import type { Consumer, LabScanner } from '../../scanner/common.ts';
import type { KernelName } from '../../scanner/wasm.ts';
import { MutantScanner, load } from './mutant.ts';

const encoder = new TextEncoder();
const PIECE = 256 * 1024;
const SYMBOLS = ['a', ',', '"', '\n', '\r'];

function every(max: number): string[] {
  const out: string[] = [];
  let level = [''];
  for (let n = 1; n <= max; n++) {
    level = level.flatMap((s) => SYMBOLS.map((c) => s + c));
    out.push(...level);
  }
  return out;
}

function beginsOf(make: (c: Consumer) => LabScanner, file: Uint8Array): string {
  const out: number[] = [];
  const scanner = make({
    begin: (o) => out.push(o),
    many: (b, n, base) => {
      for (let k = 0; k < n; k++) out.push(base + b[k]!);
    },
  });
  scanner.push(file, 0);
  return `${out.join(',')}|${scanner.state}`;
}

/** firstMismatch is the first file the build gets wrong, or undefined. */
function firstMismatch(path: string, kernel: KernelName): string | undefined {
  const build = load(path);
  const files: Uint8Array[] = [];
  for (const s of every(5)) {
    for (const at of [0, 15, 16, 62, 63, 64]) {
      files.push(encoder.encode(`${'x'.repeat(Math.max(0, at - 1))}\n${s}`));
      files.push(encoder.encode(`${'x'.repeat(at)}${s}zz\n`));
    }
  }
  // A CR that begins a record as the last byte of a piece.
  files.push(encoder.encode(`${'x'.repeat(PIECE - 2)}\n\ra\nb\n`));
  // Garbage past the end: a short file after a piece of quotes.
  for (const garbage of ['"', '\n']) {
    const fill = encoder.encode(garbage.repeat(PIECE));
    new MutantScanner(
      ',',
      { begin: () => {}, many: () => {} },
      build,
      kernel,
    ).push(fill, 0);
    const short = encoder.encode('ab,c\nd');
    const want = beginsOf((c) => new BaselineScanner(',', c.begin), short);
    const got = beginsOf(
      (c) => new MutantScanner(',', c, build, kernel),
      short,
    );
    if (got !== want) return `after ${JSON.stringify(garbage)} garbage`;
  }
  for (const file of files) {
    const want = beginsOf((c) => new BaselineScanner(',', c.begin), file);
    const got = beginsOf((c) => new MutantScanner(',', c, build, kernel), file);
    if (got !== want) return new TextDecoder().decode(file.slice(-12));
  }
  return undefined;
}

const here = (p: string): string =>
  fileURLToPath(new URL(`./build/${p}`, import.meta.url));

test('the unmutated rebuild agrees with RecordScanner', () => {
  for (const kernel of ['vectors', 'blocks'] as const) {
    expect(firstMismatch(here('scan.wasm'), kernel), kernel).toBeUndefined();
  }
});

const MUTANTS: ReadonlyArray<[string, KernelName]> = [
  ['crguard', 'blocks'],
  ['crminus', 'blocks'],
  ['valid', 'blocks'],
  ['lastlf', 'blocks'],
  ['tailstate', 'vectors'],
];

for (const [name, kernel] of MUTANTS) {
  test(`the ${name} mutant of ${kernel} is caught`, () => {
    expect(firstMismatch(here(`${name}/scan.wasm`), kernel)).toBeDefined();
  });
}
