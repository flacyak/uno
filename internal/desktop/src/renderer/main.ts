// The shell: the tab strip, the grid, the status bar, and what the menu means.
//
// It owns *when* things happen and nothing about what they do. Opening a file
// is `Workspace.open` over an engine, changing a cell is `sheet.set`, saving is
// `workspace.bytes` handed to the host. Every one of those is testable without
// a window, which is the seam this file exists to keep.

import "./app.css";

import { Engine, messagePort } from "@uno/grid/engine";
import type { MessagePortLike, Reply, Request, SourceRef } from "@uno/grid/engine";

import type { Host } from "../shared/host.ts";
import { Grid } from "./grid.ts";
import { electronHost } from "./host.ts";
import { Workspace } from "./workspace.ts";

/** The extensions the app will try to open. Anything else is very likely a
 * mis-drop, and saying so is better than a parser error. */
const OPENABLE = [".uno", ".csv", ".tsv"];

type MenuChannel = "menu:open" | "menu:save" | "menu:save-as" | "menu:mode";

interface MenuBridge {
  on(channel: MenuChannel, fn: () => void): void;
  onOpenPath(fn: (path: string) => void): void;
}

class Shell {
  private workspace: Workspace | undefined;
  private readonly grid: Grid;
  /** Counts opens, so one that finishes after a later one does not replace it. */
  private opens = 0;
  private switching = false;

  private readonly root = must(document.querySelector<HTMLElement>("#app"));
  private readonly tabs = must(document.querySelector<HTMLElement>("#tabs"));
  private readonly empty = must(document.querySelector<HTMLElement>("#empty"));
  private readonly content = must(document.querySelector<HTMLElement>("#content"));
  private readonly statusMode = must(document.querySelector<HTMLElement>("#status-mode"));
  private readonly statusFile = must(document.querySelector<HTMLElement>("#status-file"));
  private readonly statusMsg = must(document.querySelector<HTMLElement>("#status-msg"));
  private readonly statusCell = must(document.querySelector<HTMLElement>("#status-cell"));

  constructor(private readonly host: Host) {
    this.grid = new Grid(this.content, {
      onSelect: () => this.paintStatus(),
      onEdit: (row, col, value) => this.edit(row, col, value),
      onLocked: () => this.say("View · Ctrl+E to transform"),
    });

    this.wireDrop();
    this.wireKeys();
    this.paintStatus();
  }

  // --------------------------------------------------------------- opening

  async open(): Promise<void> {
    try {
      const ref = await this.host.open();
      if (ref === undefined) return; // cancelled, which is not a failure
      await this.load(ref, "path" in ref ? ref.path : "");
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /** Open a file by path: named on the command line, or double-clicked in the
   * file manager. */
  async openPath(path: string): Promise<void> {
    const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    await this.load({ name, path }, path);
  }

  /**
   * load starts an engine for the file and shows what it serves.
   *
   * A file that will not open leaves whatever was already open alone, and its
   * engine is closed. A half-loaded workspace is worse than a refused one.
   */
  private async load(ref: SourceRef, savePath: string): Promise<void> {
    const open = ++this.opens;
    let engine: Engine | undefined;

    try {
      const port = await this.host.connect();
      engine = new Engine(messagePort<Reply, Request>(port as MessagePortLike));
      engine.onProgress = () => this.repaint();
      engine.onError = (msg) => this.say(msg, true);

      const w = await Workspace.open(ref, engine, savePath, () => this.repaint());
      if (open !== this.opens) {
        w.close(); // a later open finished first
        return;
      }

      this.workspace?.close();
      this.workspace = w;
      this.grid.show(w.rows, w.editable);
      this.empty.hidden = true;
      this.content.hidden = false;
      this.grid.focus();
      this.say("");
    } catch (err) {
      engine?.close();
      if (open === this.opens) this.say(message(err), true);
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

      try {
        // A dropped workspace saves with a dialog the first time. That is one
        // question, once, and it keeps a drop from quietly writing over a file
        // the person may have dragged out of somewhere they did not mean to.
        void this.load(this.host.dropped(file), "");
      } catch (err) {
        this.say(message(err), true);
      }
    });
  }

  // ----------------------------------------------------------------- modes

  private wireKeys(): void {
    // Here rather than as a menu accelerator, so that the key reaches the page
    // and the menu item only shows it. Both call the same toggle.
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void this.toggleMode();
      }
    });
  }

  /**
   * toggleMode moves between view and transform.
   *
   * The switch is explicit because transform is where a keystroke changes the
   * file, and that should follow a decision to change it rather than a stray key
   * while scrolling.
   */
  async toggleMode(): Promise<void> {
    const w = this.workspace;
    if (w === undefined || this.switching) return;

    if (w.mode === "transform") {
      w.view();
    } else {
      this.switching = true;
      if (w.sheet === undefined) this.say("loading for transform…");
      try {
        await w.transform();
        this.say("");
      } catch (err) {
        this.say(message(err), true);
      } finally {
        this.switching = false;
      }
      if (this.workspace !== w) return;
    }

    this.grid.show(w.rows, w.editable, true);
    this.grid.focus();
    this.paintTabs();
    this.paintStatus();
  }

  // --------------------------------------------------------------- editing

  private edit(row: number, col: number, value: string): void {
    const sheet = this.workspace?.sheet;
    if (sheet === undefined) return;

    try {
      sheet.set(row, col, value);
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

  /** Rows landed or the index moved: the body and the status bar, nothing else. */
  private repaint(): void {
    this.grid.repaint();
    this.paintStatus();
  }

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

    const grow = document.createElement("span");
    grow.className = "grow";

    const seg = document.createElement("span");
    seg.className = "seg";
    seg.title = "Ctrl+E";
    for (const [mode, label] of [
      ["view", "View"],
      ["transform", "Transform"],
    ] as const) {
      const option = document.createElement("span");
      option.textContent = label;
      if (w.mode === mode) option.className = mode === "view" ? "on" : "on t";
      else option.addEventListener("click", () => void this.toggleMode());
      seg.append(option);
    }

    this.tabs.append(tab, grow, seg);
  }

  private paintStatus(): void {
    const w = this.workspace;
    this.statusFile.textContent = w === undefined ? "no file open" : w.status();
    this.statusMode.textContent = w === undefined ? "" : w.mode.toUpperCase();
    this.statusMode.className = w?.mode === "transform" ? "mode t" : "mode";

    if (w === undefined) {
      this.statusCell.textContent = "";
      return;
    }
    const { row, col } = this.grid.selection();
    const header = w.rows.columns[col]?.header ?? "";
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

const bridge = window.uno;
if (bridge === undefined) {
  // Nothing here works without the bridge, and a blank window explains nothing.
  document.body.textContent = "uno could not reach its host process.";
} else {
  const shell = new Shell(electronHost(bridge));
  const menu = (window as unknown as { unoMenu?: MenuBridge }).unoMenu;

  menu?.on("menu:open", () => void shell.open());
  menu?.on("menu:save", () => void shell.save());
  menu?.on("menu:save-as", () => void shell.saveAs());
  menu?.on("menu:mode", () => void shell.toggleMode());
  menu?.onOpenPath((path) => void shell.openPath(path));

  document.querySelector("#open")?.addEventListener("click", () => void shell.open());
}
