// The only bridge between the renderer and the machine.
//
// Context isolation is on, so the renderer has no `require`, no `node:fs`, and
// no way to reach the main process except through what is exposed here. That is
// the point: the surface is a handful of functions, so a bug in the renderer --
// or something nasty in a spreadsheet somebody sent -- has a handful of things
// to reach for rather than a filesystem.

import type { SourceRef } from "@uno/grid/engine";
import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { Bridge } from "../shared/host.ts";

const bridge: Bridge = {
  open: () => ipcRenderer.invoke("file:open") as Promise<SourceRef | undefined>,

  add: () => ipcRenderer.invoke("file:add") as Promise<SourceRef[]>,

  /**
   * A dropped File is turned into its path here, because only preload can ask.
   * The engine opens files by path, and a File that came from somewhere other
   * than the disk -- a drag out of a browser -- has none to give.
   */
  dropped(file) {
    const path = webUtils.getPathForFile(file);
    if (path === "") throw new Error(`${file.name} is not a file on this machine`);
    return { name: file.name, path };
  },

  connect: (id) => ipcRenderer.send("engine:connect", id),

  pickSave: (suggestedName) =>
    ipcRenderer.invoke("file:pick-save", suggestedName) as Promise<string | undefined>,

  save: (path, bytes) => ipcRenderer.invoke("file:save", path, bytes) as Promise<void>,
};

contextBridge.exposeInMainWorld("uno", bridge);

/**
 * An engine's port, handed on to the page.
 *
 * Ports cannot go through contextBridge, and posting to the window is the way
 * Electron gives for moving one into the main world. The id is the one the page
 * asked with, so two engines started together each find their own.
 */
ipcRenderer.on("engine:port", (event, id: number) => {
  window.postMessage({ unoEnginePort: id }, "*", event.ports);
});

/**
 * The menu's accelerators, forwarded.
 *
 * The main process owns the menu because Electron requires it to, but it cannot
 * answer any of these -- whether a workspace is open, whether it has unsaved
 * edits, which cell is selected -- so each item is a message rather than an
 * action, and the renderer decides what it means.
 */
contextBridge.exposeInMainWorld("unoMenu", {
  on(
    channel: "menu:open" | "menu:add" | "menu:save" | "menu:save-as" | "menu:mode",
    fn: () => void,
  ): void {
    ipcRenderer.on(channel, () => fn());
  },

  /**
   * A file named on the command line, or handed over by the desktop when
   * somebody double-clicks a .csv.
   *
   * It carries a path because a path is what the engine opens, and because a
   * workspace opened this way should save back to where it came from without
   * asking.
   */
  onOpenPath(fn: (path: string) => void): void {
    ipcRenderer.on("menu:open-path", (_event, path: string) => fn(path));
  },

  /** Files named together on the command line, added to one workspace in order. */
  onAddPaths(fn: (paths: string[]) => void): void {
    ipcRenderer.on("menu:add-paths", (_event, paths: string[]) => fn(paths));
  },

  /**
   * Edit → Input. The renderer keeps which strategy was chosen, so the menu tells
   * it when a person picks one, and it tells the menu which to check at start.
   */
  onInput(fn: (name: string) => void): void {
    ipcRenderer.on("menu:input", (_event, name: string) => fn(name));
  },
  inputChosen(name: string): void {
    ipcRenderer.send("input:chosen", name);
  },
});
