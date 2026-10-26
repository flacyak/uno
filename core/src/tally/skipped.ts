/**
 * @fileoverview What a fold left out.
 */

/** Cells or rows a fold left out, as blank or as not a number. */
export interface Skipped {
  blank: number;
  unparsed: number;
}
