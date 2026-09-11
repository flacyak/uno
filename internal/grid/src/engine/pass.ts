// Passes: work that reads a whole file a chunk at a time.
//
// Indexing is the first one. Validation, deduplication, splitting and format
// conversion are the next four, and each is this loop with a different body:
// read a chunk, do the work, say how far it got, stop when told. What a pass is
// handed is written down once here, so a pass can run in the engine that serves
// the view or in a worker of its own without knowing which.

import type { Format } from "../ingest/index.ts";
import type { ByteSource } from "../store/index.ts";
import type { RowIndex, Tuning } from "./rows.ts";

export interface PassContext {
  readonly source: ByteSource;
  readonly format: Format;
  readonly index: RowIndex;
  readonly tuning: Tuning;
  /** Checked between chunks. A pass that sees it aborted returns early. */
  readonly signal: AbortSignal;
  /** Called after every chunk. The caller decides how often anyone hears about it. */
  progress(): void;
}

/**
 * indexPass reads from the first data record to the end of the file and notes
 * where every block of rows starts.
 *
 * Every chunk is an awaited read, so a request that arrives mid-scan runs at the
 * next one: it waits for one chunk of scanning at most, never for the file.
 */
export async function indexPass(ctx: PassContext): Promise<void> {
  const { source, format, index, tuning, signal } = ctx;
  const scanner = format.scanner((offset) => index.begin(offset));

  for (let at = format.dataStart; at < source.size;) {
    if (signal.aborted) return;
    const chunk = await source.read(at, Math.min(tuning.chunkBytes, source.size - at));
    if (chunk.length === 0) break; // the file shrank after it was opened
    scanner.push(chunk, at);
    at += chunk.length;
    index.scanned = at;
    ctx.progress();
  }

  index.complete = true;
  ctx.progress();
}
