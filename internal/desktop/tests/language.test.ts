// The language the app speaks: the choice kept, the system's languages matched
// to the ones the app has, and what hears of a change.

import { beforeEach, expect, test } from "vite-plus/test";

import { PSEUDO_LOCALE } from "../scripts/pseudo.js";
import { baseLocale, getLocale, locales } from "../src/paraglide/runtime.js";
import {
  LANGUAGE_KEY,
  Language,
  SYSTEM,
  languageName,
  offered,
  preferred,
} from "../src/renderer/language.ts";
import type { Keeps } from "../src/renderer/theme.ts";

class Kept implements Keeps {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** Every language the app has messages for, the pseudo-locale among them. */
const ALL = offered(true);

let kept: Kept;

beforeEach(() => {
  kept = new Kept();
});

test("the pseudo-locale is offered where the app is worked on, and nowhere else", () => {
  expect(offered(true)).toEqual(locales);
  expect(offered(false)).not.toContain(PSEUDO_LOCALE);
  expect(offered(false)).toContain(baseLocale);
});

test("the system's first language the app has is the one preferred", () => {
  expect(preferred([PSEUDO_LOCALE, "en"], ALL)).toBe(PSEUDO_LOCALE);
  // One the app does not have is passed over for the next.
  expect(preferred(["tlh", PSEUDO_LOCALE], ALL)).toBe(PSEUDO_LOCALE);
});

test("a region the app has no messages for reads its language's", () => {
  expect(preferred(["en-GB"], ALL)).toBe("en");
  expect(preferred(["EN-gb"], ALL)).toBe("en");
  expect(preferred(["es-MX", "en-US"], ALL)).toBe("es");
});

test("a system that prefers none of them gets the base locale", () => {
  expect(preferred(["tlh", "xx-YY"], ALL)).toBe(baseLocale);
  expect(preferred([], ALL)).toBe(baseLocale);
});

test("a language not on offer is not preferred, though the app has its messages", () => {
  expect(preferred([PSEUDO_LOCALE], offered(false))).toBe(baseLocale);
});

test("a new install follows the system", () => {
  const language = new Language(kept, [PSEUDO_LOCALE], ALL);
  expect(language.choice).toBe(SYSTEM);
  expect(language.locale).toBe(PSEUDO_LOCALE);
  expect(getLocale()).toBe(PSEUDO_LOCALE);
});

test("a language chosen is spoken, kept, and spoken again at the next launch", () => {
  const language = new Language(kept, ["en"], ALL);
  language.choose(PSEUDO_LOCALE);
  expect(getLocale()).toBe(PSEUDO_LOCALE);
  expect(kept.getItem(LANGUAGE_KEY)).toBe(PSEUDO_LOCALE);

  const next = new Language(kept, ["en"], ALL);
  expect(next.choice).toBe(PSEUDO_LOCALE);
  expect(getLocale()).toBe(PSEUDO_LOCALE);
});

test("a language kept by a build that offered it is not spoken by one that does not", () => {
  kept.setItem(LANGUAGE_KEY, PSEUDO_LOCALE);
  const language = new Language(kept, ["en"], offered(false));
  expect(language.choice).toBe(SYSTEM);
  expect(getLocale()).toBe("en");
});

test("something kept that is no language at all follows the system", () => {
  kept.setItem(LANGUAGE_KEY, "tlh");
  expect(new Language(kept, ["en"], ALL).choice).toBe(SYSTEM);
});

test("a change of language is heard, and a choice that changes nothing is not", () => {
  const language = new Language(kept, ["en"], ALL);
  let heard = 0;
  language.onChange(() => heard++);

  language.choose(PSEUDO_LOCALE);
  expect(heard).toBe(1);
  // The same language again.
  language.choose(PSEUDO_LOCALE);
  expect(heard).toBe(1);
  // The system's is English, and so is the choice it is changed to: kept, not heard.
  language.choose("en");
  expect(heard).toBe(2);
  language.choose(SYSTEM);
  expect(heard).toBe(2);
  expect(kept.getItem(LANGUAGE_KEY)).toBe(SYSTEM);
});

test("a language is named as it names itself, capitalised as it would at the head of a line", () => {
  expect(languageName("en")).toBe("English");
  expect(languageName("es")).toBe("Español");
});
