// Shared helpers for the pattern recogniser tests.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { read } from "../../src/ingest/index.ts";
import { snap } from "../../src/pattern/index.ts";
import type { Proposal } from "../../src/pattern/index.ts";
import { Sheet } from "../../src/sheet/index.ts";

/** A one-column sheet with the given header and values. */
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
 * sales-q3.csv as a sheet. 3,152 of its 4,812 units values have a thousands
 * separator.
 */
export function sales(): Sheet {
  const path = fileURLToPath(new URL("../testdata/sales-q3.csv", import.meta.url));
  return read("sales-q3.csv", readFileSync(path));
}
