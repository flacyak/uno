// The app's language: a locale the app has messages for, or the best match
// for the system's preferred languages.
//
// The choice is kept in local storage and defaults to following the
// system.

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

/** Storage key for the chosen language. */
export const LANGUAGE_KEY = "uno.language";

/** The choice value that means follow the system. */
export const SYSTEM = "system";

/** A locale, or SYSTEM to follow the system's preference. */
export type LanguageChoice = Locale | typeof SYSTEM;

/**
 * Returns the locales a person can choose from. The pseudo-locale is only
 * included in dev builds.
 */
export function offered(dev: boolean): readonly Locale[] {
  return locales.filter((locale) => dev || locale !== PSEUDO_LOCALE);
}

/**
 * Returns the first system language found among the offered locales. An
 * exact tag match wins; otherwise the first offered locale with the same
 * language wins. en-AU matches en-US, pt matches pt-BR, es-MX matches es.
 * Falls back to the base locale.
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

/** Returns the language part of a tag, lower-cased: the en of en-GB. */
function languageOf(tag: string): string {
  return tag.split("-")[0]!.toLowerCase();
}

/** Returns a locale's name in its own language, capitalised: Español. */
export function languageName(locale: Locale): string {
  const name = new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}

/**
 * Sets the runtime locale in place. The locale is set synchronously, so it
 * is in effect when this returns. Listeners redraw the page themselves.
 */
function speak(locale: Locale): void {
  void setLocale(locale, { reload: false });
}

/**
 * Language holds the stored language choice and the locale it resolves to.
 *
 * A stored value outside the offered locales is treated as SYSTEM.
 */
export class Language {
  private chosen: LanguageChoice;
  private readonly heard: Array<() => void> = [];

  constructor(
    private readonly keeps: Keeps,
    /** The system's preferred languages, in order: navigator.languages. */
    private readonly system: readonly string[],
    /** The locales a person can choose from. */
    readonly offered: readonly Locale[],
  ) {
    const kept = keeps.getItem(LANGUAGE_KEY);
    this.chosen = isLocale(kept) && offered.includes(kept) ? kept : SYSTEM;
    speak(this.locale);
  }

  get choice(): LanguageChoice {
    return this.chosen;
  }

  /** The locale the current choice resolves to. */
  get locale(): Locale {
    return this.chosen === SYSTEM ? preferred(this.system, this.offered) : this.chosen;
  }

  /** Stores a new choice and applies it. Listeners run only if the locale changed. */
  choose(choice: LanguageChoice): void {
    this.chosen = choice;
    this.keeps.setItem(LANGUAGE_KEY, choice);
    if (this.locale === getLocale()) return;
    speak(this.locale);
    for (const fn of this.heard) fn();
  }

  /** Registers a listener called whenever the locale changes. */
  onChange(fn: () => void): void {
    this.heard.push(fn);
  }
}
