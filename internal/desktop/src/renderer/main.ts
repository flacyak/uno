// The shell: the tab strip, the grid, the status bar, and what the menu means.
//
// It owns *when* things happen and nothing about what they do. Opening a file
// is `Workspace.fromFile`, changing a cell is `sheet.set`, saving is
// `workspace.bytes` handed to the host. Every one of those is testable without
// a window, which is the seam this file exists to keep.

import "./app.css";

import { Grid } from "./grid.ts";
import { Workspace } from "./workspace.ts";
import type { Host } from "../shared/host.ts";

/** The extensions the app will try to open. Anything else is very likely a
 * mis-drop, and saying so is better than a parser error. */
const OPENABLE = [".uno", ".csv", ".tsv"];

interface MenuBridge {
  on(channel: "menu:open" | "menu:save" | "menu:save-as", fn: () => void): void;
  onOpenPath(fn: (path: string) => void): void;
}

class Shell {
  private workspace: Workspace | undefined;
  private readonly grid: Grid;

  private readonly root = must(document.querySelector<HTMLElement>("#app"));
  private readonly tabs = must(document.querySelector<HTMLElement>("#tabs"));
  private readonly empty = must(document.querySelector<HTMLElement>("#empty"));
  private readonly content = must(document.querySelector<HTMLElement>("#content"));
  private readonly statusFile = must(document.querySelector<HTMLElement>("#status-file"));
  private readonly statusMsg = must(document.querySelector<HTMLElement>("#status-msg"));
  private readonly statusCell = must(document.querySelector<HTMLElement>("#status-cell"));

  constructor(private readonly host: Host) {
    this.grid = new Grid(this.content, {
      onSelect: () => this.paintStatus(),
      onEdit: (row, col, value) => this.edit(row, col, value),
    });

    this.wireDrop();
    this.paintStatus();
  }

  // --------------------------------------------------------------- opening

  async open(): Promise<void> {
    try {
      const picked = await this.host.open();
      if (picked === undefined) return; // cancelled, which is not a failure
      this.load(picked.name, picked.path, picked.bytes);
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /** Open a file by path: named on the command line, or double-clicked in the
   * file manager. */
  async openPath(path: string): Promise<void> {
    try {
      const picked = await this.host.read(path);
      this.load(picked.name, picked.path, picked.bytes);
    } catch (err) {
      this.say(message(err), true);
    }
  }

  private load(name: string, path: string, bytes: Uint8Array): void {
    try {
      this.workspace = Workspace.fromFile(name, path, bytes);
      this.grid.show(this.workspace.sheet);
      this.empty.hidden = true;
      this.content.hidden = false;
      this.grid.focus();
      this.say("");
    } catch (err) {
      // A file that will not open leaves whatever was already open alone. A
      // half-loaded workspace is worse than a refused one.
      this.say(message(err), true);
    }
    this.paintTabs();
    this.paintStatus();
  }

  /**
   * Dropping a file is the fastest way in, and the one the design leads with.
   *
   * The whole window is the target rather than a rectangle inside it: a person
   * dropping a spreadsheet on a window means to open it, and making them find
   * the panel is a rule the app made up.
   */
  private wireDrop(): void {
    const stop = (e: DragEvent): void => {
      e.preventDefault();
      e.stopPropagation();
    };

    this.root.addEventListener("dragover", (e) => {
      stop(e);
      this.empty.classList.add("over");
    });
    this.root.addEventListener("dragleave", (e) => {
      stop(e);
      this.empty.classList.remove("over");
    });
    this.root.addEventListener("drop", (e) => {
      stop(e);
      this.empty.classList.remove("over");

      const file = e.dataTransfer?.files[0];
      if (file === undefined) return;

      const name = file.name;
      if (!OPENABLE.some((ext) => name.toLowerCase().endsWith(ext))) {
        this.say(`${name} is not a spreadsheet uno can open`, true);
        return;
      }

      void file
        .arrayBuffer()
        .then((buf) => {
          // A dropped file has no path in a sandboxed renderer, so a workspace
          // opened this way saves with a dialog the first time. That is one
          // question, once, and the alternative is a path the renderer had no
          // business knowing.
          this.load(name, "", new Uint8Array(buf));
        })
        .catch((err: unknown) => this.say(message(err), true));
    });
  }

  // --------------------------------------------------------------- editing

  private edit(row: number, col: number, value: string): void {
    const w = this.workspace;
    if (w === undefined) return;

    try {
      w.sheet.set(row, col, value);
      this.say("");
    } catch (err) {
      // The sheet refuses a cell it will not let a person type into -- a bound
      // column, a row that is not there. Saying which is the whole point of it
      // refusing by name.
      this.say(message(err), true);
    }
    // An edit can change a column's kind, and a bound column anywhere in view
    // may have recomputed, so the header and the body are both redrawn.
    this.grid.refresh();
    this.paintTabs();
    this.paintStatus();
  }

  // ---------------------------------------------------------------- saving

  async save(): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    if (w.path === "") return this.saveAs();

    try {
      await this.host.save(w.path, w.bytes(this.grid.selection()));
      w.saved(w.path);
      this.say(`saved ${w.path}`);
    } catch (err) {
      this.say(message(err), true);
    }
    this.paintTabs();
    this.paintStatus();
  }

  async saveAs(): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;

    try {
      const path = await this.host.saveAs(w.suggestedFileName, w.bytes(this.grid.selection()));
      if (path === undefined) return; // cancelled
      w.saved(path);
      this.say(`saved ${path}`);
    } catch (err) {
      this.say(message(err), true);
    }
    this.paintTabs();
    this.paintStatus();
  }

  // -------------------------------------------------------------- painting

  private paintTabs(): void {
    const w = this.workspace;
    this.tabs.replaceChildren();
    if (w === undefined) return;

    const tab = document.createElement("span");
    tab.className = "tab active";
    tab.append(document.createTextNode(w.name));
    // The dot is the only thing in the window that says there is unsaved work.
    if (w.dirty) {
      const dot = document.createElement("span");
      dot.className = "dirty";
      dot.title = "unsaved edits";
      tab.append(dot);
    }
    this.tabs.append(tab);
  }

  private paintStatus(): void {
    const w = this.workspace;
    this.statusFile.textContent = w === undefined ? "no file open" : w.status();

    if (w === undefined) {
      this.statusCell.textContent = "";
      return;
    }
    const { row, col } = this.grid.selection();
    const header = w.sheet.columns[col]?.header ?? "";
    this.statusCell.textContent = `${header} · row ${row + 1}`;
  }

  /** One line, and the only place the shell talks. An error stays until the
   * next thing happens, so it cannot be missed by blinking. */
  private say(text: string, isError = false): void {
    this.statusMsg.textContent = text;
    this.statusMsg.className = isError ? "err" : "";
  }
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error("the renderer's markup is missing an element it needs");
  return value;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------------ start

const host = window.uno;
if (host === undefined) {
  // Nothing here works without the bridge, and a blank window explains nothing.
  document.body.textContent = "uno could not reach its host process.";
} else {
  const shell = new Shell(host);
  const menu = (window as unknown as { unoMenu?: MenuBridge }).unoMenu;

  menu?.on("menu:open", () => void shell.open());
  menu?.on("menu:save", () => void shell.save());
  menu?.on("menu:save-as", () => void shell.saveAs());
  menu?.onOpenPath((path) => void shell.openPath(path));

  document.querySelector("#open")?.addEventListener("click", () => void shell.open());
}
