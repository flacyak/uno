// Naming files and writing bytes, and nothing else.
//
// Reading is not here. An engine reads a file by path in a process of its own,
// a piece at a time, so the main process never holds a file's contents on the
// way in.
//
// The atomic write is `internal/safefile/write.go`, and it is here rather than
// in `@uno/grid` for the reason it is its own package in Go: saving is the one
// operation in uno that can destroy something, and the promise -- the
// previously saved file is still there -- belongs wherever the filesystem is.

import type { SourceRef } from "@uno/grid/engine";
import { constants } from "node:fs";
import { mkdtemp, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function sourceAt(path: string): SourceRef {
  return { name: basename(path), path };
}

/**
 * writeAtomic publishes bytes to path.
 *
 * Everything goes to a temp file in the same directory, so the rename that
 * publishes it stays on one filesystem and stays atomic. A failure anywhere --
 * from the write, from the sync, from the rename -- leaves the previous file
 * untouched and leaves no half-written part behind for the next person to find.
 */
export async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const scratch = await mkdtemp(join(dirname(path), ".uno-"));
  const tmp = join(scratch, "part");

  try {
    // 0644 because the result is an ordinary user file. The private mode a temp
    // file is created with is a decision about the temp file, not the document.
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try {
      await fh.writeFile(bytes);
      await fh.sync(); // durable before the swap, not after
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
