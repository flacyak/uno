// The platform interface the renderer uses: pick files, start an engine,
// save a workspace or a connection, and quit.
//
// Files are passed by reference. `open` returns one (a path or an s3://
// URL) and the engine reads from it. `save` writes a
// .uno, which holds the log and source references.
//
// The Electron implementation is `preload` plus `renderer/host.ts`.

import type { MessagePortLike, SourceRef } from "@uno/grid/engine";
import type { Connection } from "@uno/grid/library";

export interface Host {
  /** Shows the open dialog. Returns undefined when the user cancels. */
  open(): Promise<SourceRef | undefined>;

  /** Shows the add-sources dialog. Returns an empty list when the user
   * cancels. */
  add(): Promise<SourceRef[]>;

  /** Returns the source reference for a dropped File. Throws for a file off
   * this machine's disk, such as a drag out of a browser. */
  dropped(file: File): SourceRef;

  /** Starts an engine that owns one workspace. Returns the port that talks
   * to it. Closing the port ends the engine. */
  connect(): Promise<MessagePortLike>;

  /**
   * Shows the save dialog. Returns undefined when the user cancels.
   *
   * Separate from `save` because the workspace needs the target path before
   * it can serialize: sources under the same folder are written as relative
   * paths.
   */
  pickSave(suggestedName: string): Promise<string | undefined>;

  /** Writes bytes to a path. The write is atomic. */
  save(path: string, bytes: Uint8Array): Promise<void>;

  /**
   * Writes a connection to the connections folder and returns the saved copy
   * with its timestamps. The write is atomic. A connection containing
   * anything that looks like a secret key is rejected.
   *
   * The caller is responsible for telling its engine to reload connections.
   */
  saveConnection(c: Connection): Promise<Connection>;

  /** Closes the window. The app quits with its last window. */
  quit(): void;
}

/**
 * The object preload exposes on `window.uno`. Same as Host except for
 * `connect`, `saveConnection` and `dropped`.
 *
 * contextBridge carries plain values only, so a MessagePort travels by
 * postMessage: `connect(id)` asks for one, and preload posts it to the
 * window tagged with that id. `electronHost` in the renderer turns that back
 * into `Host.connect`.
 */
export interface Bridge extends Omit<Host, "connect" | "saveConnection" | "dropped"> {
  connect(id: number): void;
  /** Returns the source reference for a dropped File, or undefined for a
   * file off this machine's disk. `electronHost` turns undefined into a
   * localized error. */
  dropped(file: File): SourceRef | undefined;
  /**
   * Saves a connection given as the text of its .unof file. Text is used
   * because it crosses contextBridge intact; Map and Date values may arrive
   * changed.
   */
  saveConnection(id: string, text: string): Promise<void>;
}

declare global {
  interface Window {
    /** Set by preload. The renderer runs with context isolation on, so this
     * is its only way to reach the main process. */
    uno?: Bridge;
  }
}
