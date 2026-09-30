// The message files, checked against each other.
//
// The compiler catches a call site naming a message the base locale lacks.
// These tests catch a translation that leaves a message out, drops a
// variable, lacks a form for one of its language's plurals, or writes a
// plural as one plain sentence.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { baseLocale, locales } from "../src/paraglide/runtime.js";

const MESSAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "messages");

/** One message with variants, as the message file writes it. */
interface Variants {
  declarations: string[];
  selectors: string[];
  match: Record<string, string>;
}

type Message = string | [Variants];

function read(locale: string): Map<string, Message> {
  const file = JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), "utf8")) as Record<
    string,
    Message
  >;
  return new Map(Object.entries(file).filter(([key]) => !key.startsWith("$")));
}

/** Every pattern a message has: its one, or one for each variant. */
function patterns(message: Message): string[] {
  return typeof message === "string" ? [message] : Object.values(message[0].match);
}

/** The variables and markup a pattern names in braces, escaped braces aside. */
function named(pattern: string): string[] {
  const unescaped = pattern.replace(/\\./g, "");
  return [...unescaped.matchAll(/\{([^}]*)\}/g)].map((found) => found[1]!).sort();
}

/** What a message takes: the inputs it declares, or the variables its pattern names. */
function inputs(message: Message): string[] {
  if (typeof message === "string") return [...new Set(named(message))];
  return message[0].declarations
    .filter((d) => d.startsWith("input "))
    .map((d) => d.slice("input ".length))
    .sort();
}

/** The plural forms a variant is written for: the `one` of `plural=one`. */
function forms(message: [Variants]): string[] {
  return Object.keys(message[0].match).map((when) => when.slice(when.indexOf("=") + 1));
}

const base = read(baseLocale);

test("the base locale has messages to check the others against", () => {
  expect(base.size).toBeGreaterThan(0);
});

describe.each(locales.map((locale) => [locale]))("%s", (locale) => {
  const messages = read(locale);

  test("has every message the base locale has, and none it does not", () => {
    expect([...messages.keys()].sort()).toEqual([...base.keys()].sort());
  });

  // The call site passes a number where the base message has variants, and
  // text where it is one pattern. A translation must have the same shape.
  test("is one pattern, or has variants, as the base locale's is", () => {
    for (const [key, message] of messages) {
      expect(typeof message, key).toBe(typeof base.get(key));
    }
  });

  test("takes the same inputs for every message", () => {
    for (const [key, message] of messages) {
      expect(inputs(message), key).toEqual(inputs(base.get(key)!));
    }
  });

  test("names nothing in a pattern that the message does not have", () => {
    for (const [key, message] of messages) {
      if (typeof message === "string") continue;
      const declared = message[0].declarations.map((d) => d.split(" ")[1]!);
      for (const pattern of patterns(message)) {
        for (const name of named(pattern)) expect(declared, `${key}: {${name}}`).toContain(name);
      }
    }
  });

  test("has a form for every plural its language has", () => {
    const needed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories.toSorted();
    for (const [key, message] of messages) {
      if (typeof message === "string") continue;
      expect(forms(message).toSorted(), key).toEqual(needed);
    }
  });
});
