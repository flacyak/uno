// End-to-end test of the core modules together on sales-q3.csv: open a file,
// edit a few cells, accept the proposed rule, bind a column formula, save a
// workspace document, and read it back.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { newManifest, readDocument, writeDocument } from "../src/document/index.ts";
import type { Document } from "../src/document/index.ts";
import { parse as parseFormula } from "../src/formula/index.ts";
import { read } from "../src/ingest/index.ts";
import { snap } from "../src/pattern/index.ts";
import { describe as describeProgram, text as programText } from "../src/program/index.ts";
import { CHANNEL, COLS, COMMAS_LEFT, ROWS, UNITS } from "./testdata/sales-q3.ts";

function salesBytes(): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL("./testdata/sales-q3.csv", import.meta.url))),
  );
}

test("a workspace survives being built, saved and reopened", () => {
  const raw = salesBytes();
  const s = read("sales-q3.csv", raw);

  // 1. The file opens and the delimiter is detected from the bytes.
  expect(s.rows()).toBe(ROWS);
  expect(s.cols()).toBe(COLS);
  expect(s.source).toBe("UTF-8 · delimiter ','");

  // 2. The units column has comma-separated numbers, so it reads as flagged text.
  expect(s.columns[UNITS]!.header).toBe("units");
  expect(s.columns[UNITS]!.kind).toBe("text");
  expect(s.columns[UNITS]!.flagged).toBe(true);

  // 3. After three hand edits, the pattern recogniser proposes a rule for the rest.
  s.set(0, UNITS, "1204");
  s.set(2, UNITS, "1455");
  s.set(4, UNITS, "2038");

  const p = snap(s).propose();
  expect(p, "no proposal from three consistent edits").toBeDefined();
  expect(programText(p!.prog)).toBe('replace(/,/, "")');
  expect(describeProgram(p!.prog)).toBe("remove commas");
  expect(p!.affects).toBe(COMMAS_LEFT);

  // 4. Applying the rule adds one log entry, changes 3,149 cells, and the
  //    column stops being flagged.
  s.apply(p!.col, p!.prog);
  expect(s.columns[UNITS]!.kind).toBe("num");
  expect(s.columns[UNITS]!.flagged).toBe(false);
  expect(s.editCount(), "three edits and one rule").toBe(4);

  // 5. Bind a formula over the fixed column. Row 0 has revenue 48160.00 and
  //    1,204 units, so the unit price is 40.
  s.bind(CHANNEL, parseFormula("revenue / units"));
  const unitPrice = s.display(0, CHANNEL);
  expect(unitPrice).toBe("40");

  // 6. Save the document. The manifest counts five log entries: three edits,
  //    one rule, and one binding.
  const doc: Document = {
    manifest: newManifest(),
    sources: [
      {
        id: "sales-q3",
        name: "sales-q3.csv",
        raw,
        rows: s.rows(),
        cols: s.cols(),
        state: {
          active: { row: 0, col: UNITS },
          columnFormulas: [{ col: CHANNEL, ref: "unit-price" }],
        },
      },
    ],
    active: "sales-q3",
    log: s.edits().map((edit) => ({ source: "sales-q3", edit })),
    extra: new Map(),
    at: "",
  };
  const bytes = writeDocument(doc);
  expect(doc.manifest.edits.count).toBe(5);
  expect(doc.manifest.sources[0]!.bytes).toBe(raw.length);

  // 7. Read it back. The rule is replayed and the bound column is recomputed
  //    from its expression.
  const back = readDocument("sales-q3.uno", bytes);
  const sheet = back.sheets!.get("sales-q3")!;
  expect(sheet.rows()).toBe(ROWS);
  expect(sheet.raw(0, UNITS)).toBe("1204");
  expect(sheet.columns[UNITS]!.kind).toBe("num");
  expect(sheet.binding(CHANNEL)).toBe("revenue / units");
  expect(sheet.display(0, CHANNEL)).toBe(unitPrice);
  expect(back.sources[0]!.state.active).toEqual({ row: 0, col: UNITS });
  expect(back.sources[0]!.state.columnFormulas).toEqual([{ col: CHANNEL, ref: "unit-price" }]);

  // Every row of the bound column matches the original sheet.
  for (let row = 0; row < sheet.rows(); row++) {
    expect(sheet.display(row, CHANNEL), `row ${row}`).toBe(s.display(row, CHANNEL));
  }

  // 8. The recogniser's propose returns undefined.
  expect(snap(sheet).propose()).toBeUndefined();
});
