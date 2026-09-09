// The whole core, end to end, on the file the app was designed around.
//
// Every other test file pins one module. This one is the only place the modules
// meet, and it is the shape of what an Electron shell will actually do: open a
// file, fix a few cells, accept what the recogniser offers, bind a column, save
// a workspace, and open it again somewhere else.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { newManifest, readDocument, writeDocument } from "../src/document/index.ts";
import type { Document } from "../src/document/index.ts";
import { parse as parseFormula } from "../src/formula/index.ts";
import { read } from "../src/ingest/index.ts";
import { snap } from "../src/pattern/index.ts";
import { describe as describeProgram, text as programText } from "../src/program/index.ts";

// date,region,rep,channel,units,revenue
const CHANNEL = 3;
const UNITS = 4;

function salesBytes(): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL("./testdata/sales-q3.csv", import.meta.url))),
  );
}

test("a workspace survives being built, saved and reopened", () => {
  const raw = salesBytes();
  const s = read("sales-q3.csv", raw);

  // 1. It opens, and the delimiter was guessed from the bytes.
  expect(s.rows()).toBe(4812);
  expect(s.cols()).toBe(6);
  expect(s.source).toBe("UTF-8 · delimiter ','");

  // 2. units looks numeric and does not parse: numeric data wearing a costume.
  expect(s.columns[UNITS]!.header).toBe("units");
  expect(s.columns[UNITS]!.kind).toBe("text");
  expect(s.columns[UNITS]!.flagged).toBe(true);

  // 3. Three cells fixed by hand, and the recogniser offers the rest.
  s.set(0, UNITS, "1204");
  s.set(2, UNITS, "1455");
  s.set(4, UNITS, "2038");

  const p = snap(s).propose();
  expect(p, "no proposal from three consistent edits").toBeDefined();
  expect(programText(p!.prog)).toBe('replace(/,/, "")');
  expect(describeProgram(p!.prog)).toBe("remove commas");
  expect(p!.affects).toBe(3149);

  // 4. Accepting it is one line in the log for 3,149 changed cells, and the
  //    column stops being flagged.
  s.apply(p!.col, p!.prog);
  expect(s.columns[UNITS]!.kind).toBe("num");
  expect(s.columns[UNITS]!.flagged).toBe(false);
  expect(s.editCount(), "three edits and one rule").toBe(4);

  // 5. A formula over the column that was just fixed. Binding channel to the
  //    unit price is what the Go suite does with this same file, and 48160.00
  //    over 1,204 units is 40.
  s.bind(CHANNEL, parseFormula("revenue / units"));
  const unitPrice = s.display(0, CHANNEL);
  expect(unitPrice).toBe("40");

  // 6. Saved, and the log stayed proportional to what the person did rather
  //    than to how much data they did it to.
  const doc: Document = {
    manifest: {
      ...newManifest("sales-q3.csv"),
      sheet: { rows: s.rows(), cols: s.cols(), entry: "" },
    },
    raw,
    state: {
      active: { row: 0, col: UNITS },
      columnFormulas: [{ col: CHANNEL, ref: "unit-price" }],
    },
    edits: s.edits(),
    extra: new Map(),
  };
  const bytes = writeDocument(doc);
  expect(doc.manifest.edits.count).toBe(5);
  expect(doc.manifest.source.bytes).toBe(raw.length);

  // 7. Reopened, it is the same workspace: the rule replayed, and the bound
  //    column recomputed from the expression rather than from stored results.
  const back = readDocument("sales-q3.uno", bytes);
  expect(back.sheet!.rows()).toBe(4812);
  expect(back.sheet!.raw(0, UNITS)).toBe("1204");
  expect(back.sheet!.columns[UNITS]!.kind).toBe("num");
  expect(back.sheet!.binding(CHANNEL)).toBe("revenue / units");
  expect(back.sheet!.display(0, CHANNEL)).toBe(unitPrice);
  expect(back.state.active).toEqual({ row: 0, col: UNITS });
  expect(back.state.columnFormulas).toEqual([{ col: CHANNEL, ref: "unit-price" }]);

  // Every one of the 4,812 values came back off one line of the log.
  for (let row = 0; row < back.sheet!.rows(); row++) {
    expect(back.sheet!.display(row, CHANNEL), `row ${row}`).toBe(s.display(row, CHANNEL));
  }

  // 8. And the recogniser has nothing left to ask about.
  expect(snap(back.sheet!).propose()).toBeUndefined();
});
