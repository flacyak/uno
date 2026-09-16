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

/** The longest id library/index.ts accepts. */
const ID_LIMIT = 200;

/** Formats a formula and parses the text back. */
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

// formatFormula sets modified on every save and created only when it is unset.
test("resaving keeps the time the formula was first written", () => {
  const first = formatFormula(column("f", "F", "a + b")).stamped;
  expect(first.created).toBeDefined();

  const second = formatFormula(first).stamped;
  expect(second.created).toEqual(first.created);
});

// A notation formula is written with the refs key left out.
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

// Unknown keys are kept in `extra` and written back on save.
test("keys this build does not know survive a save and read", () => {
  const text = JSON.stringify(
    {
      format: FORMAT_VERSION,
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

// Unknown keys are written in name order.
test("unknown keys are written in a stable order", () => {
  const text = JSON.stringify({
    format: FORMAT_VERSION,
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

// validID refuses ids that could name a path or are too long.
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
    "x".repeat(ID_LIMIT + 1),
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

// parseFormula also validates the id.
test("a file whose id names a path is refused on read", () => {
  const text = JSON.stringify({
    format: FORMAT_VERSION,
    id: "../escape",
    name: "F",
    kind: "column",
    expr: "a",
  });
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

// The written file is portable between machines.
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

// "<" is written as is.
test("a comparison is written as it was typed", () => {
  const { text } = formatFormula(column("f", "F", "a < b"));
  expect(text).toContain("a < b");
  expect(text).not.toContain("\\u003c");
});

test("a file that is not readable is refused by name", () => {
  expect(() => parseFormula("broken.unof", "{not json")).toThrow(/broken\.unof/);
  expect(() => parseFormula("broken.unof", "[1,2,3]")).toThrow(/broken\.unof/);
});

// A kind other than column or notation is refused with the file name and kind
// in the message.
test("a kind this build does not know is refused by name", () => {
  const text = JSON.stringify({ format: FORMAT_VERSION, id: "f", name: "F", kind: "connection" });
  expect(() => parseFormula("f.unof", text)).toThrow(/f\.unof.*"connection"/);
});

test("a file with no kind is refused by name", () => {
  const text = JSON.stringify({ format: FORMAT_VERSION, id: "f", name: "F", expr: "a" });
  expect(() => parseFormula("f.unof", text)).toThrow(/f\.unof.*no kind/);
});
