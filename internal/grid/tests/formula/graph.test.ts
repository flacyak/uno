import { describe, expect, test } from "vite-plus/test";

import { Graph, parse } from "../../src/formula/index.ts";

function bind(g: Graph, col: string, src: string): void {
  g.bind(col, parse(src));
}

// bind throws on a cycle. The message lists every column in the loop. The
// graph is left as it was.
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
      const g = new Graph();
      for (const [col, src] of c.prior ?? []) bind(g, col, src);

      expect(() => bind(g, c.col, c.src)).toThrow(c.want);

      // The graph is left as it was.
      expect(g.downstreamOf(c.col)).not.toContain(c.col);
    });
  }
});

// Two columns reading one input and a third reading both is allowed.
test("a diamond is not a cycle", () => {
  const g = new Graph();
  bind(g, "left", "base * 2");
  bind(g, "right", "base + 1");
  expect(() => bind(g, "total", "left + right")).not.toThrow();
});

// downstreamOf returns the columns that depend on `col`, in an order where
// every column comes after the columns it reads.
describe("downstreamOf orders a recalculation", () => {
  const g = new Graph();
  bind(g, "left", "base * 2");
  bind(g, "right", "base + 1");
  bind(g, "total", "left + right");

  const cases: Array<[string, string[]]> = [
    ["base", ["left", "right", "total"]],
    ["left", ["total"]],
    ["right", ["total"]],
    ["total", []], // a leaf
    ["region", []], // outside every formula
  ];

  for (const [col, want] of cases) {
    test(col, () => {
      expect(g.downstreamOf(col)).toEqual(want);
    });
  }
});

// A chain comes back in dependency order.
test("downstreamOf follows a chain", () => {
  const g = new Graph();
  bind(g, "b", "a * 2");
  bind(g, "c", "b * 2");
  bind(g, "d", "c + b");

  expect(g.downstreamOf("a")).toEqual(["b", "c", "d"]);
});

// Binding a column again drops the edges from its old expression.
test("rebinding replaces the old dependencies", () => {
  const g = new Graph();
  bind(g, "margin", "price * 2");
  bind(g, "margin", "cost * 2");

  expect(g.downstreamOf("price")).toEqual([]);
  expect(g.downstreamOf("cost")).toEqual(["margin"]);
});

// unbind removes the column's edges, so a binding that would have cycled
// through it is accepted.
test("unbinding leaves no edges to cycle against", () => {
  const g = new Graph();
  bind(g, "margin", "price - cost");

  // margin reads price, so price reading margin is a cycle.
  expect(() => bind(g, "price", "margin * 2")).toThrow();

  g.unbind("margin");

  expect(() => bind(g, "price", "margin * 2")).not.toThrow();
  expect(g.downstreamOf("cost")).toEqual([]);
});
