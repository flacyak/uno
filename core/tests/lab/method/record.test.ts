/**
 * @fileoverview The stand-in record writes under METHOD_OUT_DIR when it is set.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { OUT_ENV, outFolder, record } from './record.ts';
import type { Metric } from './record.ts';

const was = process.env[OUT_ENV];
afterEach(() => {
  if (was === undefined) delete process.env[OUT_ENV];
  else process.env[OUT_ENV] = was;
});

test('metrics go to <METHOD_OUT_DIR>/<kind>/<suite>.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'method-record-'));
  try {
    process.env[OUT_ENV] = dir;
    const metrics: Metric[] = [{ name: 'scan: ms', unit: 'ms', value: 1.5 }];
    record('scan', metrics, 'performance');
    expect(outFolder('performance')).toBe(`${join(dir, 'performance')}/`);
    expect(
      JSON.parse(readFileSync(join(dir, 'performance', 'scan.json'), 'utf8')),
    ).toEqual(metrics);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without METHOD_OUT_DIR the folder is core/out/<kind>/', () => {
  delete process.env[OUT_ENV];
  expect(outFolder('performance')).toMatch(/core\/out\/performance\/$/);
});
