/**
 * @fileoverview Hive partition folders: a path under a dataset's root read as
 * the key=value pairs its folders name.
 *
 * Spark, Hive, DuckDB and Polars write a dataset as folders such as
 * year=2024/month=9.
 */

/** The value Hive writes for a null partition, which reads as empty. */
export const HIVE_NULL = '__HIVE_DEFAULT_PARTITION__';

/** Partition is the keys a path's folders name, in path order, and their values. */
export interface Partition {
  readonly keys: readonly string[];
  readonly values: readonly string[];
}

/**
 * partitionOf reads the key=value folders of a path under a dataset's root.
 * The file's own name is not read.
 *
 * A folder with no '=', more than one, or nothing before it names no key.
 * A value is kept as written, '+' included, and HIVE_NULL reads as empty.
 */
export function partitionOf(relative: string): Partition {
  const keys: string[] = [];
  const values: string[] = [];
  for (const folder of relative.split('/').slice(0, -1)) {
    const [key, value, ...more] = folder.split('=');
    if (value === undefined || more.length > 0 || key === '') continue;
    keys.push(key);
    values.push(value === HIVE_NULL ? '' : value);
  }
  return { keys, values };
}
