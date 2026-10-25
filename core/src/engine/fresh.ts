/**
 * @fileoverview Whether a source's file is still the one it opened, told from
 * one stat of its path without reading it.
 */

import type { Entry } from '@store';
import type { Link } from './protocol.ts';

/**
 * unchanged says whether `entry`, a stat of the link's path now, is the file
 * the source opened at `size` bytes. Where either side has a version, the
 * versions decide. Otherwise the size and the modified time do, and a file
 * that does not say when it was written is never unchanged.
 */
export function unchanged(link: Link, size: number, entry: Entry): boolean {
  if (link.version !== undefined || entry.version !== undefined) {
    return link.version === entry.version;
  }
  return (
    link.modified !== undefined &&
    entry.bytes === size &&
    entry.modified?.getTime() === link.modified
  );
}
