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
// `peekHead` is the half that is bytes and nothing else: detect the format the
// way an open would, name the columns, and hand back the rows the window
// happened to hold. It never touches a handler, which is what lets every
// awkward shape a real file can put in front of it -- a row cut in two, a
// quoted field cut in two, a header with nothing under it -- be a string in a
// test rather than a fixture on a disk.

import { labelOf, openFormat } from "../ingest/index.ts";
import type { HeaderMode } from "../ingest/index.ts";
import type { Peeked } from "./protocol.ts";
import { bytesSource, openWith } from "../store/index.ts";
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

/** How many rows under the header a peek answers with. */
export const PEEK_ROWS = 20;

/** The front of a file, and how big the whole file is. */
export interface Head {
  bytes: Uint8Array;
  size: number;
}

/** What a caller may narrow from the defaults `peek` otherwise reads and answers with. */
export interface PeekLimits {
  bytes?: number;
  rows?: number;
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

/**
 * peekHead turns a head already in hand into the header and rows a panel
 * shows, without opening anything.
 *
 * The format is detected by handing `openFormat` a `bytesSource` over the
 * head's bytes rather than the file the head came from. That is the trick
 * that keeps a peek's cost at the one read `readHead` already paid for: a
 * bytes-source says its size is however many bytes it holds, so the format
 * reader believes the window is the whole file and never asks it for more.
 * Pointing `openFormat` at the real file would let it grow its own read to
 * chase a header that runs past 64 KB, which is exactly the second request a
 * peek exists to not make.
 */
export async function peekHead(
  name: string,
  head: Head,
  rows: number = PEEK_ROWS,
  header: HeaderMode = "first",
): Promise<Peeked> {
  const format = await openFormat(name, bytesSource(head.bytes), header);

  // Whether the window holds the whole file is what decides how the last
  // record in it is treated below, so it is worked out once, up front.
  const whole = head.bytes.length >= head.size;

  const starts: number[] = [];
  const scanner = format.scanner((offset) => {
    if (starts.length <= rows) starts.push(offset); // bounded: one more than wanted is enough
  });
  scanner.push(head.bytes.subarray(format.dataStart), format.dataStart);

  let records: string[][] = [];
  if (starts.length > 0) {
    // The window ends where the bytes ran out and not where a row did, so the
    // last record in it is usually half of one -- unless the window reached
    // the true end of the file, in which case there is nothing after that
    // last record to have cut it short. Drawing the half would put a value on
    // screen that the file does not actually contain, so it is dropped rather
    // than shown: every row this returns is a whole one, or there are none.
    const stop =
      starts.length > rows
        ? starts[rows]! // one more start than asked for bounds the last wanted row exactly
        : whole
          ? head.bytes.length
          : starts[starts.length - 1]!; // drop the record the window cut off
    records = format.decode(head.bytes.subarray(starts[0], stop));
  }

  // A row as wide as the header is what the grid draws, so a preview and an
  // opened tab agree about the same file: short rows are padded, and fields
  // past the header's width are dropped.
  const width = format.columns.length;
  const rowsOut = records.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));

  return { label: labelOf(format), header: format.columns, rows: rowsOut };
}

/** peek reads the front of ref and answers with what it holds: one open, one read, one close. */
export async function peek(
  handlers: readonly FileHandler[],
  ref: FileRef,
  limits: PeekLimits = {},
): Promise<Peeked> {
  // Several files read as one say whether they have a header row, and a peek
  // at them shows what an open would: with none, the first line is a row.
  const header = "parts" in ref ? ref.header : "first";
  return peekHead(ref.name, await readHead(handlers, ref, limits.bytes), limits.rows, header);
}
