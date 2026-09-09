// The Node implementation of FileStore, and the only file in the package that
// imports node:fs.
//
// Its `write` is internal/safefile/write.go: build a sibling temp file, fsync
// it, and rename over the target, so an interrupted write loses the new content
// rather than the content already there.

import { constants } from "node:fs";
import { mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FileStore } from "./index.ts";

/**
 * nodeStore is a FileStore backed by the local filesystem.
 *
 * It is created rather than exported as a singleton so a caller can wrap it --
 * a test with a temp directory, a sandbox with a path prefix -- without the
 * core learning that either exists.
 */
export function nodeStore(): FileStore {
  return {
    async read(path: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(path));
    },

    /**
     * write publishes bytes to path atomically.
     *
     * Everything goes to a temp file in the same directory, so the rename that
     * publishes it stays on one filesystem and stays atomic. A failure anywhere
     * -- from the write, from the sync, from the rename -- leaves the previous
     * file untouched and leaves no debris behind.
     */
    async write(path: string, bytes: Uint8Array): Promise<void> {
      const dir = dirname(path);
      const scratch = await mkdtemp(join(dir, ".uno-"));
      const tmp = join(scratch, "part");

      try {
        // 0644 because the result is an ordinary user file. The private mode a
        // temp file is created with is a decision about the temp file, not
        // about the document.
        const fh = await open(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644,
        );
        try {
          await fh.writeFile(bytes);
          await fh.sync(); // durable before the swap, not after
        } finally {
          await fh.close();
        }
        await rename(tmp, path);
      } catch (err) {
        await rm(scratch, { recursive: true, force: true }); // a failed write leaves no debris
        throw err;
      }
      await rm(scratch, { recursive: true, force: true });
    },

    /**
     * list names the files directly in dir.
     *
     * A directory that does not exist is empty rather than a failure: a person
     * who has never written a formula has no folder, and that is not a fault
     * worth reporting to them.
     */
    async list(dir: string): Promise<string[]> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => !e.isDirectory()).map((e) => e.name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
  };
}
