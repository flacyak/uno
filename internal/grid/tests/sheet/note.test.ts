import { expect, test } from "vite-plus/test";

import { Sheet } from "../../src/sheet/index.ts";
import { parse } from "../../src/formula/index.ts";

function noted(): Sheet {
  return new Sheet(
    "t.csv",
    ["label", "value"],
    [
      ["", "1"],
      ["", "2"],
    ],
  );
}

// A notation cell keeps the markdown someone typed and shows the symbols it
// describes. Both halves matter: the source is what they edit and what a diff
// reads, and the symbols are what the grid draws.
test("a notation cell stores its source and shows its symbols", () => {
  const s = noted();
  s.note(0, 0, "x^2");

  expect(s.raw(0, 0), "the source").toBe("x^2");
  expect(s.display(0, 0)).toBe("x²");
});

// The whole point of refusing at authoring time is that a person finds out
// while they are still typing, rather than finding an empty box in a cell later.
test("a symbol the font cannot draw is refused when it is typed", () => {
  const s = noted();

  expect(() => s.note(0, 0, "x_q")).toThrow();
  expect(s.raw(0, 0), "the refused source was stored").toBe("");
  expect(s.editCount(), "the refused note was recorded").toBe(0);
});

// One cache serves both kinds. A notation cell fills its own entry, and every
// other cell in that column still falls through to what it stores.
test("a notation cell leaves the rest of its column alone", () => {
  const s = noted();
  s.set(1, 0, "plain");
  s.note(0, 0, "\\alpha");

  expect(s.display(0, 0)).toBe("α");
  expect(s.display(1, 0)).toBe("plain");
});

// Notation replays out of the log like everything else, which is what lets the
// file store the source and rebuild the symbols rather than storing both.
test("notation replays from its source", () => {
  const s = noted();
  s.note(0, 0, "e^{x}");

  const replayed = noted();
  replayed.replay(s.edits());

  expect(replayed.display(0, 0)).toBe(s.display(0, 0));
});

// Binding over notation would leave the sources stored and stop drawing them,
// because recalculation replaces a column's cache wholesale. That is a loss a
// person would have to spot for themselves, so it is refused instead.
test("a formula cannot be bound over a column holding notation", () => {
  const s = noted();
  s.note(0, 0, "x^2");

  let thrown: Error | undefined;
  try {
    s.bind(0, parse("value * 2"));
  } catch (err) {
    thrown = err as Error;
  }

  expect(thrown, "a formula was bound over notation").toBeDefined();
  expect(thrown!.message, "the error does not say why").toContain("notation");
  expect(s.display(0, 0), "the notation should still be drawn").toBe("x²");
});

// And the other way round: a derived column shows what it computes, so there is
// nowhere in it to put notation.
test("notation cannot be written into a bound column", () => {
  const s = noted();
  s.bind(0, parse("value * 2"));

  expect(() => s.note(0, 0, "x^2")).toThrow();
  expect(s.display(0, 0), "the computed value").toBe("2");
});
