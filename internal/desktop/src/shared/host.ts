// The whole of what the renderer asks of the machine it is running on.
//
// Everything above this line is `@uno/grid`, which is pure. What is left over is
// choosing a file, starting an engine to read it, and writing a workspace back.
//
// No file's bytes cross this on the way in. `open` says where a file is, and
// the engine `connect` starts reads it from there, so a 30 GB CSV costs the
// renderer a name and a path. An object in S3 is the same: the page hands the
// engine an s3:// URL, and the engine, which holds the credentials, reads it. Nor on the way out: a .uno points at its sources
// rather than carrying them, so what `save` hands over is the log and a few
// paths whatever the data behind them weighs.
//
// The Electron implementation is `preload` plus `renderer/host.ts`; a web build
// implements the same methods with the File System Access API and a Web Worker,
// and shares every line of the renderer above it.

import type { SourceRef } from "@uno/grid/engine";

export interface Host {
  /** Ask for a file to open. Undefined when the person cancelled, which is not
   * a failure and must not be reported as one. */
  open(): Promise<SourceRef | undefined>;

  /** Ask for files to add to the open workspace as sources. Empty when the
   * person cancelled. */
  add(): Promise<SourceRef[]>;

  /** Where a dropped file is, in the form this platform's engine opens. Throws
   * for a file that is not on this machine's disk. */
  dropped(file: File): SourceRef;

  /** Start an engine, a worker that owns one workspace. The port is the only way in
   * or out of it, and closing the port ends the worker. */
  connect(): Promise<MessagePort>;

  /**
   * Ask where to save. Undefined when the person cancelled.
   *
   * Asking and writing are two calls because a workspace has to know where it
   * is going before it can be written: a source under the same folder is
   * pointed at relative to it. Cancelling then costs nothing, which it should.
   */
  pickSave(suggestedName: string): Promise<string | undefined>;

  /** Write over a file already chosen. Atomic: an interrupted save loses the
   * new bytes rather than the ones already there. */
  save(path: string, bytes: Uint8Array): Promise<void>;
}

/**
 * Bridge is what preload hands the page: Host, except for `connect`.
 *
 * A MessagePort cannot cross contextBridge, so the page asks for one by id and
 * preload posts it to the window with that id. `electronHost` in the renderer
 * turns that back into `connect`.
 */
export interface Bridge extends Omit<Host, "connect"> {
  connect(id: number): void;
}

declare global {
  interface Window {
    /**
     * Injected by preload. It is on `window` and not imported because the
     * renderer runs with context isolation on -- it has no `require`, no
     * `node:fs`, and no way to reach the main process except through what
     * preload chose to hand it.
     */
    uno?: Bridge;
  }
}
