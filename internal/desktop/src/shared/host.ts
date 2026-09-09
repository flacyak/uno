// The whole of what the renderer asks of the machine it is running on.
//
// Everything above this line is `@uno/grid`, which is pure: it turns bytes into
// a sheet and a sheet back into bytes, and knows nothing about where either
// came from. What is left over is choosing a file and moving bytes, and that is
// all this is.
//
// It is four methods because a fifth would be something the browser then has to
// pretend to have. The Electron implementation is `preload`, talking to the
// main process over IPC; a web build implements the same four against the File
// System Access API and shares every line of the renderer above it.

/** A file the person chose, and where it came from. */
export interface PickedFile {
  /**
   * Where the file lives, for a later save to write back to.
   *
   * A path is a fact about this machine, so it never reaches `@uno/grid` and
   * never goes into a .uno. The renderer holds it to answer Ctrl+S, and a web
   * build leaves it empty because there is nothing there to name.
   */
  path: string;
  /** What to call it. `ingest` picks its decoder from the extension. */
  name: string;
  bytes: Uint8Array;
}

export interface Host {
  /** Ask for a file to open. Undefined when the person cancelled, which is not
   * a failure and must not be reported as one. */
  open(): Promise<PickedFile | undefined>;

  /** Ask where to save, and write. Returns the chosen path, or undefined when
   * the person cancelled. */
  saveAs(suggestedName: string, bytes: Uint8Array): Promise<string | undefined>;

  /** Write over a file already chosen. Atomic: an interrupted save loses the
   * new bytes rather than the ones already there. */
  save(path: string, bytes: Uint8Array): Promise<void>;

  /** Read a file the person dropped or opened from a recents list. */
  read(path: string): Promise<PickedFile>;
}

declare global {
  interface Window {
    /**
     * Injected by preload. It is on `window` and not imported because the
     * renderer runs with context isolation on -- it has no `require`, no
     * `node:fs`, and no way to reach the main process except through what
     * preload chose to hand it.
     */
    uno?: Host;
  }
}
