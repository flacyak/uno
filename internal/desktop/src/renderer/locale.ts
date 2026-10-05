// The locale the app speaks, for what is written without a message: numbers.
//
// A message is already in the app's language. A number written beside it has
// to be in the same one, or a German sentence counts its rows the English way.
// toLocaleString() with no locale follows the operating system, which is a
// different setting from the app's.

import { getLocale } from "../paraglide/runtime.js";
import type { Locale } from "../paraglide/runtime.js";

/** The formatter for the locale it was made in, kept until the locale changes. */
let grouping: { locale: Locale; format: Intl.NumberFormat } | undefined;

/** num is a count as the app's locale writes it: 1,204 in English. */
export function num(n: number): string {
  const locale = getLocale();
  if (grouping?.locale !== locale) grouping = { locale, format: new Intl.NumberFormat(locale) };
  return grouping.format.format(n);
}
