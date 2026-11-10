/**
 * @fileoverview Facts about sales-q3.csv, for the tests that read it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// date,region,rep,channel,units,revenue
export const REGION = 1;
export const CHANNEL = 3;
export const UNITS = 4;
export const REVENUE = 5;

/** Data rows below the header. */
export const ROWS = 4812;
export const COLS = 6;
export const LAST_ROW = ROWS - 1;

/**
 * Cells in units that still have a thousands separator after rows 0, 2 and 4
 * are fixed by hand: 3,152 minus those three.
 */
export const COMMAS_LEFT = 3149;

// Path and bytes of the file. This module is also loaded by the stand-in S3
// under plain node, so it must stay free of TypeScript-only syntax, and by
// a page's test under happy-dom, whose URL resolves a relative address
// against the page, so the path is joined to this file's own.
export const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'sales-q3.csv',
);
export const bytes = new Uint8Array(readFileSync(FIXTURE));

/** The fixture's rows `repeats` times over, under one header. */
export function repeated(repeats: number): Uint8Array<ArrayBuffer> {
  const header = bytes.indexOf(0x0a) + 1;
  const body = bytes.subarray(header);
  const out = new Uint8Array(header + body.length * repeats);
  out.set(bytes.subarray(0, header));
  for (let i = 0; i < repeats; i++) out.set(body, header + i * body.length);
  return out;
}
