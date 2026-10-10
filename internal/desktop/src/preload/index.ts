// The preload script. Exposes `window.uno` and `window.unoMenu` to the
// renderer through contextBridge. Context isolation is on, so these are the
// renderer's only way to reach the main process.

import type { SourceRef } from "@uno/grid/engine";
import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { Bridge } from "../shared/host.ts";

const bridge: Bridge = {
  open: () => ipcRenderer.invoke("file:open") as Promise<SourceRef | undefined>,

  add: () => ipcRenderer.invoke("file:add") as Promise<SourceRef[]>,

  /**
   * Returns the path of a dropped File, or undefined for a file off this
   * machine's disk (for example a drag out of a browser). The renderer
   * reports the error, since it knows the user's language.
   */
  dropped(file) {
    const path = webUtils.getPathForFile(file);
    return path === "" ? undefined : { name: file.name, path };
  },

  connect: (id) => ipcRenderer.send("engine:connect", id),

  pickSave: (suggestedName) =>
    ipcRenderer.invoke("file:pick-save", suggestedName) as Promise<string | undefined>,

  save: (path, bytes) => ipcRenderer.invoke("file:save", path, bytes) as Promise<void>,

  saveConnection: (id, text) => ipcRenderer.invoke("connections:save", id, text) as Promise<void>,

  quit: () => ipcRenderer.send("window:close"),
};

contextBridge.exposeInMainWorld("uno", bridge);

/**
 * Forwards an engine's MessagePort to the page. contextBridge carries plain
 * values only, so the port is posted to the window tagged with the id the
 * page asked with.
 */
ipcRenderer.on("engine:port", (event, id: number) => {
  window.postMessage({ unoEnginePort: id }, "*", event.ports);
});

/**
 * Menu events forwarded from main. The renderer decides what each one does,
 * since it holds the workspace state.
 */
contextBridge.exposeInMainWorld("unoMenu", {
  on(
    channel: "menu:open" | "menu:add" | "menu:save" | "menu:save-as" | "menu:mode" | "menu:sources",
    fn: () => void,
  ): void {
    ipcRenderer.on(channel, () => fn());
  },

  /** A file to open, named on the command line or by the OS (double-click). */
  onOpenPath(fn: (path: string) => void): void {
    ipcRenderer.on("menu:open-path", (_event, path: string) => fn(path));
  },

  /** Several files named on the command line, added to one workspace in
   * order. */
  onAddPaths(fn: (paths: string[]) => void): void {
    ipcRenderer.on("menu:add-paths", (_event, paths: string[]) => fn(paths));
  },

  /** Edit > Input. `onInput` receives the strategy picked in the menu;
   * `inputChosen` tells the menu which one to check. */
  onInput(fn: (name: string) => void): void {
    ipcRenderer.on("menu:input", (_event, name: string) => fn(name));
  },
  inputChosen(name: string): void {
    ipcRenderer.send("input:chosen", name);
  },

  /** Tells main the renderer's locale, for the menu and dialogs. */
  languageChosen(locale: string): void {
    ipcRenderer.send("language:chosen", locale);
  },
});
