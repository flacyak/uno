// sales-q3.csv cut into three files, for the tests that read several files as
// one.
//
// Each part opens with the header the whole file has and holds a third of its
// rows, in order, every row ending in the CRLF it ends in there. Joined with
// the two repeats of the header left out, they are the whole file byte for
// byte.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ROWS } from "./sales-q3.ts";

/** How many parts the file is cut into. */
export const PARTS = 3;

/** Data rows in each part, not counting its header. */
export const PART_ROWS = ROWS / PARTS;

/** What each part is called, in order. */
export const PART_NAMES: readonly string[] = Array.from(
  { length: PARTS },
  (_, i) => `sales-q3-part-${i + 1}.csv`,
);

/** Where each part is on disk, in order. */
export const PART_FIXTURES: readonly string[] = PART_NAMES.map((name) =>
  fileURLToPath(new URL(`./${name}`, import.meta.url)),
);

/** Each part's bytes, in order. */
export const partBytes: readonly Uint8Array[] = PART_FIXTURES.map(
  (path) => new Uint8Array(readFileSync(path)),
);
