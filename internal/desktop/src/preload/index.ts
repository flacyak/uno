// The only bridge between the renderer and the machine.
//
// Context isolation is on, so the renderer has no `require`, no `node:fs`, and
// no way to reach the main process except through what is exposed here. That is
// the point: the surface is four functions, so a bug in the renderer -- or
// something nasty in a spreadsheet somebody sent -- has four things to reach for
// rather than a filesystem.

import { contextBridge, ipcRenderer } from "electron";

import type { Host, PickedFile } from "../shared/host.ts";

const host: Host = {
  open: () => ipcRenderer.invoke("file:open") as Promise<PickedFile | undefined>,

  saveAs: (suggestedName, bytes) =>
    ipcRenderer.invoke("file:save-as", suggestedName, bytes) as Promise<string | undefined>,

  save: (path, bytes) => ipcRenderer.invoke("file:save", path, bytes) as Promise<void>,

  read: (path) => ipcRenderer.invoke("file:read", path) as Promise<PickedFile>,
};

contextBridge.exposeInMainWorld("uno", host);

/**
 * The menu's accelerators, forwarded.
 *
 * The main process owns the menu because Electron requires it to, but it cannot
 * answer any of these -- whether a workspace is open, whether it has unsaved
 * edits, which cell is selected -- so each item is a message rather than an
 * action, and the renderer decides what it means.
 */
contextBridge.exposeInMainWorld("unoMenu", {
  on(channel: "menu:open" | "menu:save" | "menu:save-as", fn: () => void): void {
    ipcRenderer.on(channel, () => fn());
  },

  /**
   * A file named on the command line, or handed over by the desktop when
   * somebody double-clicks a .csv.
   *
   * It carries a path rather than bytes because the renderer already knows how
   * to read one, and because a workspace opened this way should save back to
   * where it came from without asking.
   */
  onOpenPath(fn: (path: string) => void): void {
    ipcRenderer.on("menu:open-path", (_event, path: string) => fn(path));
  },
});
