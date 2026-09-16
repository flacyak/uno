// Passes: work that reads a whole file one chunk at a time.
//
// A pass reads a chunk, does its work, reports progress, and stops when its
// signal is aborted. PassContext is what every pass is handed.

import type { Format } from "../ingest/index.ts";
import type { ByteSource } from "../store/index.ts";
import type { RowIndex, Tuning } from "./rows.ts";

export interface PassContext {
  readonly source: ByteSource;
  readonly format: Format;
  readonly index: RowIndex;
  readonly tuning: Tuning;
  /** Checked between chunks. An aborted pass returns early. */
  readonly signal: AbortSignal;
  /** Called after every chunk. */
  progress(): void;
}

/**
 * indexPass reads from the first data record to the end of the file and
 * records where each block of rows starts.
 *
 * Each chunk read is awaited, so other work runs between chunks.
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
