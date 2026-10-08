// Naming files and writing bytes, and nothing else.
//
// Reading is not here. An engine reads a file by path in a process of its own,
// a piece at a time, so the main process never holds a file's contents on the
// way in.
//
// The atomic write is `internal/safefile/write.go`, which the node store
// carries: saving is the one operation in uno that can destroy something, and
// the promise -- the previously saved file is still there -- is kept in the one
// place that writes to a disk, and reached from here, where the filesystem is.

import type { SourceRef } from "@uno/grid/engine";
import { fileName, parseConnection } from "@uno/grid/library";
import { nodeStore } from "@uno/grid/store/node";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

export function sourceAt(path: string): SourceRef {
  return { name: basename(path), path };
}

/** What a workspace file is called by. The engine knows a .uno by this. */
const WORKSPACE_EXT = ".uno";

/**
 * unoPath is where a Save As goes, from what its dialog answered.
 *
 * The dialog filters on .uno, and Windows and macOS add it to a name typed
 * without. GTK answers with the name as typed, and a workspace saved as
 * `sales` opens as a spreadsheet the next time, since the engine knows a .uno
 * by its name. So it is added here, once, whatever the desktop did.
 */
export function unoPath(picked: string): string {
  return picked.toLowerCase().endsWith(WORKSPACE_EXT) ? picked : picked + WORKSPACE_EXT;
}

/**
 * writeAtomic publishes bytes to path.
 *
 * Everything goes to a temp file in the same directory, so the rename that
 * publishes it stays on one filesystem and stays atomic. A failure anywhere --
 * from the write, from the sync, from the rename -- leaves the previous file
 * untouched and leaves no half-written part behind for the next person to find.
 */
export function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  return nodeStore().write(path, bytes);
}

/**
 * writeConnection saves one connection into the folder the engines read them
 * from, as <id>.unof, atomically.
 *
 * The text arrives from the page, and the page is treated as a web page: it is
 * read back as a connection here before a byte is written, so what lands in
 * the folder is a connection whose id names this file and which holds no key,
 * whatever the renderer was persuaded to send.
 */
export async function writeConnection(dir: string, id: string, text: string): Promise<void> {
  const name = fileName(id, "connection");
  const c = parseConnection(name, text);
  if (c.id !== id) throw new Error(`${name} holds connection ${JSON.stringify(c.id)}, not ${id}`);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, name), new TextEncoder().encode(text));
}
