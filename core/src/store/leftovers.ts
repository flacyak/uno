/**
 * @fileoverview What a dataset's folder holds besides its data: the files
 * Spark and Hadoop leave beside it, and the log of a table format.
 *
 * The rules follow Spark's, so a folder Spark wrote reads as the rows Spark
 * reads from it.
 */

import type { TableFormat } from '@said';

/** The suffix Hadoop gives a file while it is still being copied in. */
const COPYING = '._COPYING_';

/** The suffix of the object Hadoop's S3 file systems mark a folder with. */
const FOLDER_MARKER = '_$folder$';

/** The folder of a Delta Lake table's log. */
const DELTA_LOG = '_delta_log';

/** The folder of an Iceberg table's metadata. */
const ICEBERG_METADATA = 'metadata';

/** The suffix of an Iceberg table's metadata files, one per version. */
const ICEBERG_SUFFIX = '.metadata.json';

/** The folder of a Hudi table's timeline. */
const HUDI_TIMELINE = '.hoodie';

/**
 * passedOver says whether a file found under a dataset's root holds no rows
 * of it, from its path under the root and its size.
 *
 * A name starting with '.' is hidden. One starting with '_' is a job's
 * bookkeeping, such as _SUCCESS or _temporary, unless it is a key=value
 * folder. A file still being copied in, a folder marker and an empty file are
 * passed over too.
 */
export function passedOver(relative: string, bytes: number): boolean {
  if (bytes === 0 || relative.endsWith('/')) return true;
  return relative.split('/').some(isLeftover);
}

/** isLeftover says whether one name in a path makes the file a leftover. */
function isLeftover(name: string): boolean {
  return (
    name.startsWith('.') ||
    (name.startsWith('_') && !name.includes('=')) ||
    name.endsWith(COPYING) ||
    name.endsWith(FOLDER_MARKER)
  );
}

/**
 * tableFormatOf names the table format whose log a file under a dataset's
 * root is part of: a _delta_log folder, Iceberg's metadata/*.metadata.json,
 * or a .hoodie folder. A table's live rows are the ones its log names, and
 * passedOver would pass the log over and leave its deleted files, so this is
 * asked first.
 */
export function tableFormatOf(relative: string): TableFormat | undefined {
  const folders = relative.split('/').slice(0, -1);
  if (folders.includes(DELTA_LOG)) return 'Delta Lake';
  if (folders.includes(HUDI_TIMELINE)) return 'Hudi';
  const parent = folders.at(-1);
  if (parent === ICEBERG_METADATA && relative.endsWith(ICEBERG_SUFFIX)) {
    return 'Iceberg';
  }
  return undefined;
}
