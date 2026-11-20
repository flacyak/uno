/** @fileoverview A box plot's rows: each value's box, then Other's, or a column's one box. */

import type { BoxTally } from "@engine";
import type { Box } from "@tally";
import { m } from "@paraglide/messages";

/** A row a box plot draws: what it names, and its box. */
export interface Boxed {
  label: string;
  box: Box;
}

/**
 * boxedRows gives the rows of `tally` with a box, in the order it sends them:
 * each value's, the highest median first, then Other's, or, with no values,
 * its column's one box, named `whole`. A value with no number has none.
 */
export function boxedRows(tally: BoxTally, whole: string): Boxed[] {
  const values = tally.values.flatMap(({ value, spread }) =>
    spread.box === undefined ? [] : [{ label: value, box: spread.box }],
  );
  const rest = tally.rest?.box;
  if (rest === undefined) return values;
  return [...values, { label: values.length === 0 ? whole : m.chart_pie_other(), box: rest }];
}
