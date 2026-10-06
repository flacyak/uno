// The pseudo-locale's patterns: accented, longer, in brackets, and with what
// the compiler reads in braces left exactly as it was.

import { expect, test } from "vite-plus/test";

import { PSEUDO_CLOSE, PSEUDO_OPEN, pseudo, pseudoMessages } from "../scripts/pseudo.js";

test("every letter wears an accent, between brackets", () => {
  const out = pseudo("Save");
  expect(out.startsWith(PSEUDO_OPEN)).toBe(true);
  expect(out.endsWith(PSEUDO_CLOSE)).toBe(true);
  expect(out).toContain("Šåṽé");
  expect(out).not.toMatch(/[A-Za-z]/);
});

test("a message is padded to the length a longer language would run to", () => {
  // Ten letters, and three more for the third a translation adds.
  expect(pseudo("abcdefghij")).toBe(`${PSEUDO_OPEN}åƀçðéƒĝĥîĵ ···${PSEUDO_CLOSE}`);
  // Nothing to pad: a message of marks alone is as long as it was.
  expect(pseudo("+ - * /")).toBe(`${PSEUDO_OPEN}+ - * /${PSEUDO_CLOSE}`);
});

test("a variable is left as the compiler reads it", () => {
  expect(pseudo("saved {path}")).toBe(`${PSEUDO_OPEN}šåṽéð {path} ··${PSEUDO_CLOSE}`);
});

test("markup is left as the compiler reads it, around words that are accented", () => {
  expect(pseudo("or {#link}open one{/link}")).toBe(
    `${PSEUDO_OPEN}öŕ {#link}öþéñ öñé{/link} ···${PSEUDO_CLOSE}`,
  );
});

test("an escaped brace stays escaped", () => {
  expect(pseudo("a \\{b\\} c")).toBe(`${PSEUDO_OPEN}å \\{ƀ\\} ç ·${PSEUDO_CLOSE}`);
});

test("a message with variants keeps its selectors and has each pattern replaced", () => {
  const rows = {
    declarations: ["input count", "local plural = count: plural"],
    selectors: ["plural"],
    match: { "plural=one": "{count} row", "plural=other": "{count} rows" },
  };
  expect(pseudoMessages({ $schema: "https://example.test/schema", rows: [rows] })).toEqual({
    $schema: "https://example.test/schema",
    rows: [
      {
        ...rows,
        match: {
          "plural=one": `${PSEUDO_OPEN}{count} ŕöŵ ·${PSEUDO_CLOSE}`,
          "plural=other": `${PSEUDO_OPEN}{count} ŕöŵš ··${PSEUDO_CLOSE}`,
        },
      },
    ],
  });
});
