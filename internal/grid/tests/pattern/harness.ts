// What the recogniser tests share: the sheets they propose from.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { read } from "../../src/ingest/index.ts";
import { snap } from "../../src/pattern/index.ts";
import type { Proposal } from "../../src/pattern/index.ts";
import { Sheet } from "../../src/sheet/index.ts";

/** A sheet of a single column, which is the shape most of what the recogniser
 * does is about. */
export function oneCol(header: string, ...values: string[]): Sheet {
  return new Sheet(
    "test.csv",
    [header],
    values.map((v) => [v]),
  );
}

export function propose(s: Sheet): Proposal | undefined {
  return snap(s).propose();
}

/**
 * The file the preview is filmed from, which is the case the whole recogniser
 * exists for: 3,152 of 4,812 rows in units wear a thousands separator, and
 * fixing them by hand is the work uno is meant to remove.
 */
export function sales(): Sheet {
  const path = fileURLToPath(new URL("../testdata/sales-q3.csv", import.meta.url));
  return read("sales-q3.csv", readFileSync(path));
}
