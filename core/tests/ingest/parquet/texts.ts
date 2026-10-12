/**
 * @fileoverview The column a schema of one top-level field reads as, and
 * values written in it by textOf, for the values tests.
 */

import type { SchemaElement } from 'hyparquet/src/index.js';

import { columnsOf, textOf } from '@ingest/parquet/values';
import type { Leaf, ParquetValue } from '@ingest/parquet/values';

/**
 * The first column of a file with one top-level field, `elements[0]`, whose
 * descendants follow it.
 */
export function leafOf(...elements: SchemaElement[]): Leaf {
  const [leaf] = columnsOf([{ name: 'root', num_children: 1 }, ...elements]);
  return leaf!;
}

/**
 * Each value as textOf writes it in the column `field` reads as: one
 * element, or a top-level field with its descendants following.
 */
export function textsOf(
  field: SchemaElement | readonly SchemaElement[],
  values: readonly ParquetValue[],
): string[] {
  const leaf = leafOf(...[field].flat());
  return values.map((value) => textOf(leaf, value));
}
