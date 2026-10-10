// Facts about the fixture every smoke check opens: 4,812 rows of a real
// export, date,region,rep,channel,units,revenue.
//
// index.ts's PRELUDE interpolates the same values, so a check written as a
// string sees them under the same names.

import { baseLocale } from "../../paraglide/runtime.js";

/** The locale the smoke runs the app in, and so the one its counts are written in. */
export const LOCALE = baseLocale;

/** A count as the app writes it on screen: 4,812. */
export function counted(n: number): string {
  return n.toLocaleString(LOCALE);
}

/** A body row has the gutter cell before its columns, so a column's cell is
 * one further along in a raw row of `<td>`s. `Page.rows()` leaves the gutter
 * out; only a check that walks the DOM by hand needs this. */
export const GUTTER = 1;

export const ROWS = 4812;
export const DATE = 0;
export const REGION = 1;
export const REP = 2;
export const UNITS = 4;

/** How many cells remove commas changes once rows 1, 3 and 5 of units are
 * fixed by hand. */
export const COMMAS_LEFT = 3149;

/** A virtualising grid keeps fewer rows than this in the DOM. */
export const DOM_ROWS = 120;
