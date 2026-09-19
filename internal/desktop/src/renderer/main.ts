// The renderer's entry: the page's base styles, the shell, and the menu wired to
// it. What loads from here is what the empty window needs; the grid comes with
// the first file (see shell/shell.ts).

import "./base.css";

import { electronHost } from "./host.ts";
import type { InputName } from "./input/index.ts";
import { Shell } from "./shell/shell.ts";

type MenuChannel = "menu:open" | "menu:add" | "menu:save" | "menu:save-as" | "menu:mode";

interface MenuBridge {
  on(channel: MenuChannel, fn: () => void): void;
  onOpenPath(fn: (path: string) => void): void;
  onAddPaths(fn: (paths: string[]) => void): void;
  onInput(fn: (name: string) => void): void;
  inputChosen(name: InputName): void;
}

const bridge = window.uno;
if (bridge === undefined) {
  // Nothing here works without the bridge, and a blank window explains nothing.
  document.body.textContent = "uno could not reach its host process.";
} else {
  const shell = new Shell(electronHost(bridge));
  const menu = (window as unknown as { unoMenu?: MenuBridge }).unoMenu;

  menu?.on("menu:open", () => void shell.open());
  menu?.on("menu:add", () => void shell.add());
  menu?.on("menu:save", () => void shell.save());
  menu?.on("menu:save-as", () => void shell.saveAs());
  menu?.on("menu:mode", () => shell.toggleMode());
  menu?.onOpenPath((path) => void shell.openPath(path));
  menu?.onAddPaths((paths) => void shell.addPaths(paths));
  menu?.onInput((name) => shell.setInput(name));
  menu?.inputChosen(shell.inputName);

  document.querySelector("#open")?.addEventListener("click", () => void shell.open());
}
