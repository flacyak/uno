// What sales-q3.csv holds, for the tests that read it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// date,region,rep,channel,units,revenue
export const REGION = 1;
export const CHANNEL = 3;
export const UNITS = 4;
export const REVENUE = 5;

/** Data rows, not counting the header. */
export const ROWS = 4812;
export const COLS = 6;
export const LAST_ROW = ROWS - 1;

/**
 * What remove commas changes in units once rows 0, 2 and 4 are fixed by hand:
 * 3,152 cells wear a separator, less those three.
 */
export const COMMAS_LEFT = 3149;

// The file itself. It lives here rather than in the engine harness because the
// stand-in S3 serves it too, and the desktop smoke run starts that stand-in
// with plain node -- which strips types rather than compiling them, and cannot
// take the parameter properties the engine is written with. Nothing above this
// line needs an import, and now nothing below it does either.
export const FIXTURE = fileURLToPath(new URL("./sales-q3.csv", import.meta.url));
export const bytes = new Uint8Array(readFileSync(FIXTURE));
