// The app's language: the choice kept, the system's languages matched to the
// ones the app has, and who hears of a change.

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
import { Kept } from "./kept.ts";

/** Every locale the app has messages for, including the pseudo-locale. */
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
  expect(preferred([PSEUDO_LOCALE, "en-US"], ALL)).toBe(PSEUDO_LOCALE);
  // A language the app lacks is skipped.
  expect(preferred(["tlh", PSEUDO_LOCALE], ALL)).toBe(PSEUDO_LOCALE);
});

test("a language and region the app has is read exactly, whatever its case", () => {
  expect(preferred(["en-GB"], ALL)).toBe("en-GB");
  expect(preferred(["EN-gb"], ALL)).toBe("en-GB");
  expect(preferred(["pt-PT", "pt-BR"], ALL)).toBe("pt-PT");
});

test("a region the app has no messages for reads its language in the first region offered", () => {
  expect(preferred(["en-AU"], ALL)).toBe("en-US");
  expect(preferred(["pt"], ALL)).toBe("pt-BR");
  expect(preferred(["pt-AO"], ALL)).toBe("pt-BR");
  expect(preferred(["es-MX", "en-US"], ALL)).toBe("es");
});

test("the first language the app has wins over a later one it has exactly", () => {
  expect(preferred(["en-AU", "pt-PT"], ALL)).toBe("en-US");
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
  const language = new Language(kept, ["en-US"], ALL);
  language.choose(PSEUDO_LOCALE);
  expect(getLocale()).toBe(PSEUDO_LOCALE);
  expect(kept.getItem(LANGUAGE_KEY)).toBe(PSEUDO_LOCALE);

  const next = new Language(kept, ["en-US"], ALL);
  expect(next.choice).toBe(PSEUDO_LOCALE);
  expect(getLocale()).toBe(PSEUDO_LOCALE);
});

test("a language kept by a build that offered it is not spoken by one that does not", () => {
  kept.setItem(LANGUAGE_KEY, PSEUDO_LOCALE);
  const language = new Language(kept, ["en-US"], offered(false));
  expect(language.choice).toBe(SYSTEM);
  expect(getLocale()).toBe("en-US");
});

test("something kept that is no language at all follows the system", () => {
  kept.setItem(LANGUAGE_KEY, "tlh");
  expect(new Language(kept, ["en-US"], ALL).choice).toBe(SYSTEM);
});

test("a change of language is heard, and a choice that changes nothing is not", () => {
  const language = new Language(kept, ["en-US"], ALL);
  let heard = 0;
  language.onChange(() => heard++);

  language.choose(PSEUDO_LOCALE);
  expect(heard).toBe(1);
  // The same language again leaves the count where it was.
  language.choose(PSEUDO_LOCALE);
  expect(heard).toBe(1);
  // The system's language is en-US. Choosing SYSTEM after en-US changes the
  // choice kept, and the locale stays the same, so the count stays.
  language.choose("en-US");
  expect(heard).toBe(2);
  language.choose(SYSTEM);
  expect(heard).toBe(2);
  expect(kept.getItem(LANGUAGE_KEY)).toBe(SYSTEM);
});

test("a language is named as it names itself, capitalised as it would at the head of a line", () => {
  expect(languageName("en-US")).toBe("American English");
  expect(languageName("en-GB")).toBe("British English");
  expect(languageName("es")).toBe("Español");
  expect(languageName("pt-BR")).toBe("Português (Brasil)");
  expect(languageName("pt-PT")).toBe("Português europeu");
});
