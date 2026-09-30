// Facts about sales-q3.csv, for the tests that read it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
// under plain node, so it must stay free of TypeScript-only syntax.
export const FIXTURE = fileURLToPath(new URL("./sales-q3.csv", import.meta.url));
export const bytes = new Uint8Array(readFileSync(FIXTURE));
