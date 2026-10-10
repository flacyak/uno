// File paths and file writes for the main process.
//
// An engine reads a file by path in its own process.
// Writes go through the node store, which does an atomic temp-file-and-rename
// write (internal/safefile/write.go).

import type { SourceRef } from "@uno/grid/engine";
import { fileName, parseConnection } from "@uno/grid/library";
import { nodeStore } from "@uno/grid/store/node";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

export function sourceAt(path: string): SourceRef {
  return { name: basename(path), path };
}

/** The workspace file extension. The engine recognises a workspace by it. */
const WORKSPACE_EXT = ".uno";

/**
 * unoPath returns the path a Save As dialog answered with, with `.uno` added
 * if it is missing. Windows and macOS add the extension themselves; GTK
 * returns the name as typed.
 */
export function unoPath(picked: string): string {
  return picked.toLowerCase().endsWith(WORKSPACE_EXT) ? picked : picked + WORKSPACE_EXT;
}

/**
 * writeAtomic writes bytes to path through a temp file in the same directory
 * and a rename. A failure at any step leaves the previous file untouched.
 */
export function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  return nodeStore().write(path, bytes);
}

/**
 * writeConnection saves one connection as `<id>.unof` in dir, atomically.
 *
 * The text is parsed as a connection before anything is written. Parsing
 * rejects a connection that holds a key, and the parsed id must match `id`.
 */
export async function writeConnection(dir: string, id: string, text: string): Promise<void> {
  const name = fileName(id, "connection");
  const c = parseConnection(name, text);
  if (c.id !== id) throw new Error(`${name} holds connection ${JSON.stringify(c.id)}, not ${id}`);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, name), new TextEncoder().encode(text));
}
