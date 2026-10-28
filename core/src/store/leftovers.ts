/**
 * @fileoverview What a dataset's folder holds besides its data: the files
 * Spark and Hadoop leave beside it.
 *
 * The rules follow Spark's, so a folder Spark wrote reads as the rows Spark
 * reads from it.
 */

/** The suffix Hadoop gives a file while it is still being copied in. */
const COPYING = '._COPYING_';

/** The suffix of the object Hadoop's S3 file systems mark a folder with. */
const FOLDER_MARKER = '_$folder$';

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
