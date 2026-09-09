import { describe, expect, test } from "vite-plus/test";

import { Graph, parse } from "../../src/formula/index.ts";

function bind(g: Graph, col: string, src: string): void {
  g.bind(col, parse(src));
}

// A cycle has to be refused at bind time. Discovered during a recalculation it
// is found with half a column already written; discovered here it is one
// person, one expression, and a path naming every step of the loop -- which is
// why the message is checked rather than only the failure.
describe("bind refuses a cycle and names the path", () => {
  const cases: Array<{
    name: string;
    prior?: Array<[string, string]>;
    col: string;
    src: string;
    want: string;
  }> = [
    {
      name: "a column that reads itself",
      col: "margin",
      src: "margin * 2",
      want: "margin would depend on itself: margin → margin",
    },
    {
      name: "two columns that read each other",
      prior: [["price", "margin + 1"]],
      col: "margin",
      src: "price * 2",
      want: "margin would depend on itself: margin → price → margin",
    },
    {
      name: "a loop of three",
      prior: [
        ["a", "b * 2"],
        ["b", "c * 2"],
      ],
      col: "c",
      src: "a * 2",
      want: "c would depend on itself: c → a → b → c",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const g = new Graph(); // a fresh graph holds nothing bound, and is usable
      for (const [col, src] of c.prior ?? []) bind(g, col, src);

      expect(() => bind(g, c.col, c.src)).toThrow(c.want);

      // The refused binding must not have been recorded anyway.
      expect(g.downstreamOf(c.col)).not.toContain(c.col);
    });
  }
});

// Two columns reading the same input and a third reading both of them is a
// diamond, not a loop. A cycle check that walked breadth of reuse rather than
// depth of dependency would refuse it, and refusing the commonest shape a
// spreadsheet takes would make formulas useless.
test("a diamond is not a cycle", () => {
  const g = new Graph();
  bind(g, "left", "base * 2");
  bind(g, "right", "base + 1");
  expect(() => bind(g, "total", "left + right")).not.toThrow();
});

// Recalculation walks only what follows from the edit, and nothing may be
// computed before what it reads. A column emitted early would compute from the
// values the edit already invalidated, which is worse than not recomputing it
// at all: it would be wrong and it would look finished.
describe("downstreamOf orders a recalculation", () => {
  const g = new Graph();
  bind(g, "left", "base * 2");
  bind(g, "right", "base + 1");
  bind(g, "total", "left + right");

  const cases: Array<[string, string[]]> = [
    ["base", ["left", "right", "total"]],
    ["left", ["total"]],
    ["right", ["total"]],
    ["total", []], // nothing reads it
    ["region", []], // a column no formula mentions
  ];

  for (const [col, want] of cases) {
    test(col, () => {
      expect(g.downstreamOf(col)).toEqual(want);
    });
  }
});

// A chain is the case where order is the whole answer: b has to be recomputed
// before c reads it.
test("downstreamOf follows a chain", () => {
  const g = new Graph();
  bind(g, "b", "a * 2");
  bind(g, "c", "b * 2");
  bind(g, "d", "c + b");

  expect(g.downstreamOf("a")).toEqual(["b", "c", "d"]);
});

// Editing a formula replaces what it depends on. An edge left behind by the
// expression someone just deleted would recalculate a column that no longer
// reads anything, and could refuse a binding for a cycle that is no longer
// there.
test("rebinding replaces the old dependencies", () => {
  const g = new Graph();
  bind(g, "margin", "price * 2");
  bind(g, "margin", "cost * 2");

  expect(g.downstreamOf("price")).toEqual([]);
  expect(g.downstreamOf("cost")).toEqual(["margin"]);
});

// A column nobody computes any more is not a step in anything. Leaving its
// edges behind would let a formula that was taken off a week ago refuse a
// binding made today, naming a loop that no longer exists.
test("unbinding leaves no edges to cycle against", () => {
  const g = new Graph();
  bind(g, "margin", "price - cost");

  // While margin reads price, a price that read margin would be a loop.
  expect(() => bind(g, "price", "margin * 2")).toThrow();

  g.unbind("margin");

  expect(() => bind(g, "price", "margin * 2")).not.toThrow();
  expect(g.downstreamOf("cost")).toEqual([]);
});
