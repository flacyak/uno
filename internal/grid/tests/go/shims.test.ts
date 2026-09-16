// The expectations here were taken from Go, by running the equivalent calls and
// recording what came back. They are the floor the rest of the port stands on:
// if one of these drifts, a cell somewhere shows a different value and nothing
// else complains.

import { describe, expect, test } from "vite-plus/test";

import {
  atoi,
  compareStrings,
  equalFold,
  findAllIndex,
  formatFloat,
  formatU,
  indexOfRunes,
  isDigit,
  isLetter,
  isSpace,
  parseFloat as goParseFloat,
  quote,
  quoteMeta,
  replaceAllLiteral,
  rfc3339,
  roundSignificant,
  runeLen,
  runes,
  sha256Hex,
  toLower,
  toUpper,
  trimSpace,
  unquote,
} from "../../src/go/index.ts";

describe("runes", () => {
  test("splits code points, not code units", () => {
    expect(runes("aé\u{1F600}")).toEqual(["a", "é", "\u{1F600}"]);
    expect(runeLen("\u{1F600}")).toBe(1);
    expect("\u{1F600}".length).toBe(2); // the reason the shim exists
  });
});

describe("compareStrings", () => {
  // strings.Compare(U+E000, U+1F600) is -1 in Go, because UTF-8 byte
  // order is code-point order. JavaScript's `<` says the opposite, because a
  // surrogate pair sorts below U+E000 as code units.
  test("orders by code point, the way UTF-8 bytes do", () => {
    const privateUse = "\ue000";
    const astral = "\u{1F600}";
    expect(compareStrings(privateUse, astral)).toBe(-1);
    expect(privateUse < astral).toBe(false); // what a naive port would do
  });

  test("agrees with the obvious answer everywhere else", () => {
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("b", "a")).toBe(1);
    expect(compareStrings("a", "a")).toBe(0);
    expect(compareStrings("a", "ab")).toBe(-1);
    expect(["total", "base", "left"].sort(compareStrings)).toEqual(["base", "left", "total"]);
  });
});

describe("case mapping", () => {
  // Go uses simple case mapping: one rune in, one rune out. These are the runes
  // where JavaScript's full mapping changes the length of the string.
  const cases: Array<[string, string, string]> = [
    ["ß", "ß", "ß"], // eszett: JS uppercases it to "SS"
    ["ﬁ", "ﬁ", "ﬁ"], // fi ligature: JS gives "FI"
    ["İ", "İ", "i"], // dotted capital I: JS lowercases to i + combining dot
    ["ǰ", "ǰ", "ǰ"],
    ["é", "É", "é"],
    ["istanbul", "ISTANBUL", "istanbul"],
  ];

  for (const [input, up, low] of cases) {
    test(`${JSON.stringify(input)} upper/lower`, () => {
      expect(toUpper(input)).toBe(up);
      expect(toLower(input)).toBe(low);
    });
  }

  test("never changes the rune count", () => {
    for (const [input] of cases) {
      expect(runeLen(toUpper(input))).toBe(runeLen(input));
      expect(runeLen(toLower(input))).toBe(runeLen(input));
    }
  });

  test("equalFold", () => {
    expect(equalFold("ABC", "abc")).toBe(true);
    expect(equalFold("ABC", "abd")).toBe(false);
  });
});

describe("unicode classes", () => {
  test("isLetter is category L, not [a-zA-Z]", () => {
    expect(isLetter("r")).toBe(true);
    expect(isLetter("é")).toBe(true); // region, accented, is a legal column name
    expect(isLetter("5")).toBe(false);
    expect(isLetter("_")).toBe(false);
  });

  test("isDigit is category Nd", () => {
    expect(isDigit("5")).toBe(true);
    expect(isDigit("٥")).toBe(true); // Arabic-Indic five
    expect(isDigit("a")).toBe(false);
  });

  test("isSpace is White_Space, which JS \\s is not", () => {
    expect(isSpace(" ")).toBe(true);
    expect(isSpace("\t")).toBe(true);
    expect(isSpace("\u0085")).toBe(true); // NEL: in Go, not in JS \s
    expect(isSpace("\u00a0")).toBe(true);
    expect(isSpace("\ufeff")).toBe(false); // in JS \s, not in Go
    expect(isSpace("x")).toBe(false);
  });

  test("trimSpace", () => {
    expect(trimSpace(" x")).toBe("x");
    expect(trimSpace("  a b  ")).toBe("a b");
    expect(trimSpace("y")).toBe("y");
    expect(trimSpace("\u00a0z\u00a0")).toBe("z"); // NBSP: Go trims it
  });
});

describe("formatFloat", () => {
  // strconv.FormatFloat(v, 'f', -1, 64): shortest round-trip, never exponential.
  const cases: Array<[number, string]> = [
    [0.22, "0.22"],
    [0.21999999999999997, "0.21999999999999997"],
    [1e21, "1000000000000000000000"],
    [1e-7, "0.0000001"],
    [1.5e-10, "0.00000000015"],
    [123456789012345680000, "123456789012345680000"],
    [0, "0"],
    [-1.5, "-1.5"],
  ];

  for (const [v, want] of cases) {
    test(`${v} => ${want}`, () => {
      expect(formatFloat(v)).toBe(want);
    });
  }

  test("1e300 prints 301 digits rather than an exponent", () => {
    const got = formatFloat(1e300);
    expect(got).toBe("1" + "0".repeat(300));
    expect(got).not.toContain("e");
  });

  test("keeps the sign of a negative zero, as Go does", () => {
    expect(formatFloat(-0)).toBe("-0");
    expect((-0).toString()).toBe("0"); // what a naive port would print
  });
});

describe("roundSignificant", () => {
  // This is what turns arithmetic showing its working into an answer, at the
  // significant digits a computed cell keeps.
  const DIGITS = 10;

  const cases: Array<[number, string]> = [
    [(40.0 - 31.2) / 40.0, "0.22"],
    [1 / 3, "0.3333333333"],
    [2 / 3, "0.6666666667"],
  ];

  for (const [v, want] of cases) {
    test(`${v} => ${want}`, () => {
      expect(formatFloat(roundSignificant(v, DIGITS))).toBe(want);
    });
  }

  test("leaves an infinity alone rather than throwing", () => {
    expect(roundSignificant(Infinity, DIGITS)).toBe(Infinity);
  });
});

describe("quote", () => {
  const cases: Array<[string, string]> = [
    ["a", '"a"'],
    ['a"b', '"a\\"b"'],
    ["a\\b", '"a\\\\b"'],
    ["tab\there", '"tab\\there"'],
    ["é", '"é"'], // printable: Go leaves it literal
    ["1,204", '"1,204"'],
    ["", '""'],
    ["nl\n", '"nl\\n"'],
    ["\u0007", '"\\a"'],
    ["\u0000", '"\\x00"'],
    ["€", '"€"'],
  ];

  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} => ${want}`, () => {
      expect(quote(input)).toBe(want);
    });
  }
});

describe("unquote", () => {
  const cases: Array<[string, string]> = [
    ['"a\\tb"', "a\tb"],
    ['"\\x41"', "A"],
    ['"€"', "€"],
    ['"$1"', "$1"],
    ['"\\101"', "A"],
    ['"\\u00e9"', "é"],
    ['""', ""],
  ];

  for (const [input, want] of cases) {
    test(`${input} => ${JSON.stringify(want)}`, () => {
      expect(unquote(input)).toBe(want);
    });
  }

  test("refuses what Go refuses", () => {
    expect(() => unquote('"a')).toThrow();
    expect(() => unquote('"\\q"')).toThrow();
    expect(() => unquote('"\\x4"')).toThrow();
  });

  test("round-trips through quote", () => {
    for (const s of ["", "a", 'a"b', "a\\b", "\t", "1,204", "€", "$1"]) {
      expect(unquote(quote(s))).toBe(s);
    }
  });
});

describe("parseFloat", () => {
  test("reads what Go reads", () => {
    expect(goParseFloat("12")).toBe(12);
    expect(goParseFloat("+7")).toBe(7);
    expect(goParseFloat("-1.5")).toBe(-1.5);
    expect(goParseFloat("1e3")).toBe(1000);
    expect(goParseFloat(".5")).toBe(0.5);
  });

  test("refuses what Number() would have accepted", () => {
    expect(goParseFloat("")).toBeUndefined();
    expect(goParseFloat("0x10")).toBeUndefined();
    expect(goParseFloat("Infinity")).toBeUndefined();
    expect(goParseFloat(" 12 ")).toBeUndefined();
    expect(goParseFloat("1.2.3")).toBeUndefined();
  });

  test("atoi is whole numbers only", () => {
    expect(atoi("12")).toBe(12);
    expect(atoi("-3")).toBe(-3);
    expect(atoi("1.5")).toBeUndefined();
    expect(atoi("")).toBeUndefined();
  });
});

describe("quoteMeta", () => {
  const cases: Array<[string, string]> = [
    [",", ","],
    ["$", "\\$"],
    ["1,204", "1,204"],
    ["a.b+c", "a\\.b\\+c"],
    ["[x]", "\\[x\\]"],
  ];

  for (const [input, want] of cases) {
    test(`${input} => ${want}`, () => {
      expect(quoteMeta(input)).toBe(want);
    });
  }

  test("what it escapes stays a valid pattern under the u flag", () => {
    for (const c of "\\.+*?()|[]{}^$") {
      expect(() => new RegExp(quoteMeta(c), "u")).not.toThrow();
      expect(new RegExp(quoteMeta(c), "u").test(c)).toBe(true);
    }
  });
});

describe("replaceAllLiteral", () => {
  test("takes the replacement as text, not as a template", () => {
    // String.replaceAll would expand these; Go never does.
    expect(replaceAllLiteral(/x/u, "axb", "$&")).toBe("a$&b");
    expect(replaceAllLiteral(/(a)/u, "aa", "$1")).toBe("$1$1");
    expect(replaceAllLiteral(/,/u, "1,204,567", "")).toBe("1204567");
  });
});

describe("findAllIndex", () => {
  test("reports every match, in code points", () => {
    expect(findAllIndex(/,/u, "1,204,567")).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  // Go returns [[0 0] [1 1] [2 3] [4 4]] here: the empty match at 3 is dropped
  // because it sits where the previous match ended.
  test("handles empty matches the way Go does", () => {
    expect(findAllIndex(/x*/u, "abxc")).toEqual([
      [0, 0],
      [1, 1],
      [2, 3],
      [4, 4],
    ]);
  });

  test("offsets are code points even past the BMP", () => {
    expect(findAllIndex(/,/u, "\u{1F600},a")).toEqual([[1, 2]]);
  });

  test("indexOfRunes", () => {
    expect(indexOfRunes("\u{1F600},a", ",")).toBe(1);
    expect(indexOfRunes("abc", "z")).toBe(-1);
  });
});

describe("fmt and hashing", () => {
  test("formatU names a codepoint without printing it", () => {
    expect(formatU("√")).toBe("U+221A");
    expect(formatU("∑")).toBe("U+2211");
  });

  test("sha256Hex agrees with crypto/sha256", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("rfc3339 truncates to the second, as encoding/json does", () => {
    expect(rfc3339(new Date(Date.UTC(2026, 8, 9, 12, 0, 0)))).toBe("2026-09-09T12:00:00Z");
  });
});
