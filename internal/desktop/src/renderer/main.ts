// Renderer entry point. Loads the base styles, creates the Shell, and wires
// the menu bridge to it. The grid module loads with the first file (see
// shell/shell.ts).

import "./base.css";

import { m } from "../paraglide/messages.js";
import type { Locale } from "../paraglide/runtime.js";
import { electronHost } from "./host.ts";
import type { InputName } from "./input/index.ts";
import { Shell } from "./shell/shell.ts";

type MenuChannel =
  | "menu:open"
  | "menu:add"
  | "menu:save"
  | "menu:save-as"
  | "menu:mode"
  | "menu:sources";

interface MenuBridge {
  on(channel: MenuChannel, fn: () => void): void;
  onOpenPath(fn: (path: string) => void): void;
  onAddPaths(fn: (paths: string[]) => void): void;
  onInput(fn: (name: string) => void): void;
  inputChosen(name: InputName): void;
  languageChosen(locale: Locale): void;
}

const bridge = window.uno;
if (bridge === undefined) {
  // Everything runs through the bridge, so a missing one shows a message.
  document.body.textContent = m.host_unreachable();
} else {
  const shell = new Shell(electronHost(bridge));
  const menu = (window as unknown as { unoMenu?: MenuBridge }).unoMenu;

  menu?.on("menu:open", () => void shell.open());
  menu?.on("menu:add", () => void shell.add());
  menu?.on("menu:save", () => void shell.save());
  menu?.on("menu:save-as", () => void shell.saveAs());
  menu?.on("menu:mode", () => shell.toggleMode());
  menu?.on("menu:sources", () => shell.showPanel());
  menu?.onOpenPath((path) => void shell.openPath(path));
  menu?.onAddPaths((paths) => void shell.addPaths(paths));
  menu?.onInput((name) => shell.setInput(name));
  // Keep the menu's input check mark in sync with the shell's input strategy.
  shell.onInput = (name) => menu?.inputChosen(name);
  menu?.inputChosen(shell.inputName);
  // Tell the main process the page's locale, so the menu and dialogs match.
  shell.language.onChange(() => menu?.languageChosen(shell.language.locale));
  menu?.languageChosen(shell.language.locale);

  document.querySelector("#open")?.addEventListener("click", () => void shell.open());
}
