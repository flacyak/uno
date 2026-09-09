import { describe, expect, test } from "vite-plus/test";

import { FORMAT_VERSION, formatFormula, parseFormula, validID } from "../../src/library/index.ts";
import type { Formula } from "../../src/library/index.ts";

function column(id: string, name: string, expr: string, refs?: string[]): Formula {
  return {
    format: 0,
    id,
    name,
    kind: "column",
    expr,
    refs,
    created: undefined,
    modified: undefined,
  };
}

/** What a save-then-read round trip does, without a filesystem in the way. */
function roundTrip(f: Formula): Formula {
  const { text } = formatFormula(f);
  return parseFormula(f.id + ".unof", text);
}

test("a saved formula reads back with every field intact", () => {
  const f = column("unit-margin", "Unit margin", "(price - cost) / price", ["cost", "price"]);
  const back = roundTrip(f);

  expect(back.id).toBe("unit-margin");
  expect(back.name).toBe("Unit margin");
  expect(back.kind).toBe("column");
  expect(back.expr).toBe("(price - cost) / price");
  expect(back.refs).toEqual(["cost", "price"]);
  expect(back.format).toBe(FORMAT_VERSION);
  expect(back.created).toBeDefined();
  expect(back.modified).toBeDefined();
});

// Modified is what this save is; created is filled in only the first time, so a
// formula cannot come to claim it was written after it was last edited.
test("resaving keeps the time the formula was first written", () => {
  const first = formatFormula(column("f", "F", "a + b")).stamped;
  expect(first.created).toBeDefined();

  const second = formatFormula(first).stamped;
  expect(second.created).toEqual(first.created);
});

// A notation formula reads nothing, so it carries no refs key at all rather
// than an empty list that would imply it could.
test("a notation formula carries no refs key at all", () => {
  const f: Formula = {
    format: 0,
    id: "variance",
    name: "Variance",
    kind: "notation",
    expr: "\\sigma^2",
    created: undefined,
    modified: undefined,
  };

  const { text } = formatFormula(f);
  expect(text).not.toContain("refs");
  expect(roundTrip(f).refs).toBeUndefined();
});

// An older uno opening a file written by a newer one must not quietly drop what
// it could not read and then write that loss back over the file.
test("keys this build does not know survive a save and read", () => {
  const text = JSON.stringify(
    {
      format: 1,
      id: "f",
      name: "F",
      kind: "column",
      expr: "a + b",
      created: "2026-01-01T00:00:00Z",
      modified: "2026-01-01T00:00:00Z",
      colour: "blue",
      futureThing: { nested: true },
    },
    undefined,
    2,
  );

  const f = parseFormula("f.unof", text);
  expect(f.extra?.get("colour")).toBe("blue");

  const written = JSON.parse(formatFormula(f).text) as Record<string, unknown>;
  expect(written["colour"]).toBe("blue");
  expect(written["futureThing"]).toEqual({ nested: true });
});

// Unknown keys are written in name order, so a save that changed nothing
// produces the same bytes as the one before it.
test("unknown keys are written in a stable order", () => {
  const text = JSON.stringify({
    format: 1,
    id: "f",
    name: "F",
    kind: "column",
    expr: "a",
    zeta: 1,
    alpha: 2,
    mu: 3,
  });

  const f = parseFormula("f.unof", text);
  const written = formatFormula(f).text;
  expect(written.indexOf('"alpha"')).toBeLessThan(written.indexOf('"mu"'));
  expect(written.indexOf('"mu"')).toBeLessThan(written.indexOf('"zeta"'));
});

// Formulas arrive from other people -- that is the point of making each one a
// file -- so the id is checked before it is ever joined to a path.
describe("an id that could name a path is refused", () => {
  const bad = [
    "",
    ".",
    "..",
    ".hidden",
    "../escape",
    "a/b",
    "a\\b",
    "C:name",
    "with\u0000null",
    "x".repeat(201),
  ];

  for (const id of bad) {
    test(JSON.stringify(id), () => {
      expect(() => validID(id)).toThrow();
    });
  }

  test("an ordinary id is accepted", () => {
    expect(() => validID("unit-margin")).not.toThrow();
    expect(() => validID("marge unitaire")).not.toThrow();
  });
});

// The id is checked on the way in as well as on the way out, so no id that
// could name a path is ever handed to a caller in the first place.
test("a file whose id names a path is refused on read", () => {
  const text = JSON.stringify({ format: 1, id: "../escape", name: "F", kind: "column", expr: "a" });
  expect(() => parseFormula("f.unof", text)).toThrow();
});

test("a formula from a newer uno is refused by name", () => {
  const text = JSON.stringify({ format: FORMAT_VERSION + 1, id: "f", name: "F", kind: "column" });

  let thrown: Error | undefined;
  try {
    parseFormula("f.unof", text);
  } catch (err) {
    thrown = err as Error;
  }
  expect(thrown).toBeDefined();
  expect(thrown!.message).toContain("f.unof");
  expect(thrown!.message).toContain("newer uno");
});

// A file that only works where it was written is not reusable anywhere.
test("a formula carries no path from the machine that wrote it", () => {
  const { text } = formatFormula(column("f", "F", "a + b", ["a", "b"]));
  expect(text).not.toContain("/home/");
  expect(text).not.toContain("path");
  expect(text).not.toContain("dir");
});

test("the times are written as whole seconds in UTC", () => {
  const { text } = formatFormula(column("f", "F", "a"));
  const written = JSON.parse(text) as Record<string, string>;

  expect(written["created"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(written["modified"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// Escaping a "<" would cost exactly the legibility that made markdown the right
// thing to store.
test("a comparison is written as it was typed", () => {
  const { text } = formatFormula(column("f", "F", "a < b"));
  expect(text).toContain("a < b");
  expect(text).not.toContain("\\u003c");
});

test("a file that is not readable is refused by name", () => {
  expect(() => parseFormula("broken.unof", "{not json")).toThrow(/broken\.unof/);
  expect(() => parseFormula("broken.unof", "[1,2,3]")).toThrow(/broken\.unof/);
});
