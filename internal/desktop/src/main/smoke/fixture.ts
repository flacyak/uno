// Facts about the fixture every smoke check opens: 4,812 rows of a real
// export, date,region,rep,channel,units,revenue. Not facts about the DOM --
// those live on `Page` -- which is why a check that has become a function
// imports these directly instead of finding them in a renderer-side prelude.
//
// index.ts's PRELUDE interpolates the same values in, so the checks that are
// still strings see the same fixture through the same names.

/** A body row has the gutter before these, so a column's cell is one further
 * along in a raw row of `<td>`s. `Page`'s `rows()` already leaves the gutter
 * out, so a check reading through it never needs this offset -- only a check
 * still walking the DOM by hand does. */
export const GUTTER = 1;

export const ROWS = 4812;
export const DATE = 0;
export const REGION = 1;
export const REP = 2;
export const UNITS = 4;

/** What remove commas changes once rows 1, 3 and 5 of units are fixed by hand. */
export const COMMAS_LEFT = 3149;

/** More rows than this in the DOM means the grid is not virtualising. */
export const DOM_ROWS = 120;
