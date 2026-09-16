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

// A notation cell stores the typed source as raw and displays the rendered
// symbols.
test("a notation cell stores its source and shows its symbols", () => {
  const s = noted();
  s.note(0, 0, "x^2");

  expect(s.raw(0, 0), "the source").toBe("x^2");
  expect(s.display(0, 0)).toBe("x²");
});

// note throws on a symbol outside the font and leaves the log as it was.
test("a symbol the font cannot draw is refused when it is typed", () => {
  const s = noted();

  expect(() => s.note(0, 0, "x_q")).toThrow();
  expect(s.raw(0, 0), "the refused source was stored").toBe("");
  expect(s.editCount(), "the refused note was recorded").toBe(0);
});

// A notation cell changes only its own display; other cells in the column
// still show their stored values.
test("a notation cell leaves the rest of its column alone", () => {
  const s = noted();
  s.set(1, 0, "plain");
  s.note(0, 0, "\\alpha");

  expect(s.display(0, 0)).toBe("α");
  expect(s.display(1, 0)).toBe("plain");
});

// Replaying a note edit renders the same symbols from the source.
test("notation replays from its source", () => {
  const s = noted();
  s.note(0, 0, "e^{x}");

  const replayed = noted();
  replayed.replay(s.edits());

  expect(replayed.display(0, 0)).toBe(s.display(0, 0));
});

// bind throws on a column that holds notation. The error mentions notation
// and the cell keeps drawing.
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

// note throws on a bound column.
test("notation cannot be written into a bound column", () => {
  const s = noted();
  s.bind(0, parse("value * 2"));

  expect(() => s.note(0, 0, "x^2")).toThrow();
  expect(s.display(0, 0), "the computed value").toBe("2");
});
