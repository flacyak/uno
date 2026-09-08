// What sales-q3.csv holds, for the tests that read it.

// date,region,rep,channel,units,revenue
export const REGION = 1;
export const CHANNEL = 3;
export const UNITS = 4;
export const REVENUE = 5;

/** Data rows, not counting the header. */
export const ROWS = 4812;
export const COLS = 6;
export const LAST_ROW = ROWS - 1;

/**
 * What remove commas changes in units once rows 0, 2 and 4 are fixed by hand:
 * 3,152 cells wear a separator, less those three.
 */
export const COMMAS_LEFT = 3149;
