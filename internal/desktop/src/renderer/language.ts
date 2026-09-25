// The language the app speaks: one of the ones it has messages for, or
// whichever of them the system prefers.
//
// It is this machine's choice and not a workspace's, kept in the page's
// storage beside the theme. Nothing kept means follow the system, which is what
// a new install does.

import {
  baseLocale,
  getLocale,
  isLocale,
  locales,
  setLocale,
  toLocale,
} from "../paraglide/runtime.js";
import type { Locale } from "../paraglide/runtime.js";
import { PSEUDO_LOCALE } from "../../scripts/pseudo.js";
import type { Keeps } from "./theme.ts";

/** Where the chosen language is kept. */
export const LANGUAGE_KEY = "uno.language";

/** Following the system, as the choice and as what is kept for it. */
export const SYSTEM = "system";

/** What a person can choose: a language, or whatever the system prefers. */
export type LanguageChoice = Locale | typeof SYSTEM;

/**
 * The languages a person is offered. The pseudo-locale is offered where the
 * app is being worked on and nowhere else: it is for checking a layout, and a
 * person who chose it by accident could not read their way back.
 */
export function offered(dev: boolean): readonly Locale[] {
  return locales.filter((locale) => dev || locale !== PSEUDO_LOCALE);
}

/**
 * preferred is the first of the system's languages the app has: as the
 * language and region exactly, or failing that as the same language in the
 * first region offered, which is the one most of its speakers are in. en-AU
 * reads en-US, pt reads pt-BR, and es-MX reads es. The base locale is what a
 * system that prefers none of them gets.
 */
export function preferred(system: readonly string[], among: readonly Locale[]): Locale {
  for (const tag of system) {
    const exact = toLocale(tag);
    if (exact !== undefined && among.includes(exact)) return exact;
    const language = languageOf(tag);
    const same = among.find((locale) => languageOf(locale) === language);
    if (same !== undefined) return same;
  }
  return baseLocale;
}

/** languageOf is a tag's language without its region: the en of en-GB. */
function languageOf(tag: string): string {
  return tag.split("-")[0]!.toLowerCase();
}

/** languageName is what a language calls itself, capitalised as it would: Español. */
export function languageName(locale: Locale): string {
  const name = new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}

/**
 * speak puts the messages in a locale. The page is written again in place by
 * whoever hears of it, since the reload the runtime offers would drop the open
 * workspace. The locale is a variable, with nothing to wait for, so it is set
 * by the time this returns.
 */
function speak(locale: Locale): void {
  void setLocale(locale, { reload: false });
}

/**
 * Language is the choice, kept between launches, and the locale the messages
 * are in because of it.
 *
 * A value kept by some other build that this one has no messages for is not
 * an error: the app follows the system, and the next choice writes over it.
 */
export class Language {
  private chosen: LanguageChoice;
  private readonly heard: Array<() => void> = [];

  constructor(
    private readonly keeps: Keeps,
    /** The system's languages, most wanted first: navigator.languages. */
    private readonly system: readonly string[],
    /** The languages on offer, which the system's are matched among. */
    readonly offered: readonly Locale[],
  ) {
    const kept = keeps.getItem(LANGUAGE_KEY);
    this.chosen = isLocale(kept) && offered.includes(kept) ? kept : SYSTEM;
    speak(this.locale);
  }

  get choice(): LanguageChoice {
    return this.chosen;
  }

  /** The locale the choice comes to. */
  get locale(): Locale {
    return this.chosen === SYSTEM ? preferred(this.system, this.offered) : this.chosen;
  }

  /** choose speaks another language, or follows the system again, and keeps it. */
  choose(choice: LanguageChoice): void {
    this.chosen = choice;
    this.keeps.setItem(LANGUAGE_KEY, choice);
    if (this.locale === getLocale()) return;
    speak(this.locale);
    for (const fn of this.heard) fn();
  }

  /** onChange is told whenever the locale the app speaks changes. */
  onChange(fn: () => void): void {
    this.heard.push(fn);
  }
}
