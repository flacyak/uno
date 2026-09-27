// Peek is what a file holds, before anything is added to the workspace.
//
// A peek answers a selection in a panel: somebody clicking down a folder of
// four hundred objects asks the same question of each one, so a 30 GB export
// and a 30 KB one have to cost the same. That is the whole design, and it is
// why this module is two halves rather than one function.
//
// `readHead` is the half that touches a handler: open once, read the front,
// and close, whatever the file turns out to be. It is the only place the cost
// this task exists for can be spent, and it spends it once -- one open, one
// read, one close -- because a person scanning a folder pays for that once per
// object regardless of which object they land on.
//
// Working out what the bytes it hands back actually are is the other half, and
// it reaches no handler at all.

import { openWith } from "../store/index.ts";
import type { FileHandler, FileRef } from "../store/index.ts";

/**
 * How much of the front of a file a peek reads.
 *
 * `ingest/format.ts` keeps its own 64 KB constant for the first read it makes
 * while opening a file for real, and this happens to land on the same number.
 * The two are not the same promise: that one is how far a header is allowed to
 * run before an open pays for a second read to find the rest of it. This one
 * is the entire read a peek ever makes, on a file of any size, full stop.
 */
export const PEEK_BYTES = 64 << 10;

/** The front of a file, and how big the whole file is. */
export interface Head {
  bytes: Uint8Array;
  size: number;
}

/**
 * readHead opens ref through the first handler that claims it, reads one
 * range from the front, and closes the file whether that read succeeded or
 * not.
 *
 * It is one read and never a loop: `read` is asked for `limit` bytes exactly
 * once, and a short answer is read as the file having ended there rather than
 * as a reason to ask again. Looping to fill a short read would turn one
 * request into two on every file smaller than the window, which is most of
 * them, and this task's whole point is that the request count does not depend
 * on what a person happens to click on.
 */
export async function readHead(
  handlers: readonly FileHandler[],
  ref: FileRef,
  limit: number = PEEK_BYTES,
): Promise<Head> {
  const file = await openWith(handlers, ref);
  try {
    const bytes = await file.read(0, Math.min(limit, file.size));
    return { bytes, size: file.size };
  } finally {
    await file.close();
  }
}
