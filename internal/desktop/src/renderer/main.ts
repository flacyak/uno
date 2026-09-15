// The shell: the tab strip, the banner, the grid, the status bar, and what the
// menu means.
//
// It owns *when* things happen and nothing about what they do. Opening a file
// is `Workspace.open` over an engine, changing a cell is `workspace.set`, saving
// is `workspace.bytes` handed to the host. Every one of those is testable
// without a window, which is the seam this file exists to keep.

import "./app.css";

import { Engine, messagePort } from "@uno/grid/engine";
import type { MessagePortLike, Offer, Reply, Request, SourceRef } from "@uno/grid/engine";
import { NO_ROW } from "@uno/grid/sheet";

import type { Host } from "../shared/host.ts";
import { Grid } from "./grid.ts";
import { electronHost } from "./host.ts";
import { command } from "./keys.ts";
import type { Command } from "./keys.ts";
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
  /** The offer a person said "not now" to, so it stays gone until it changes. */
  private dismissed = "";

  private readonly root = must(document.querySelector<HTMLElement>("#app"));
  private readonly tabs = must(document.querySelector<HTMLElement>("#tabs"));
  private readonly banner = must(document.querySelector<HTMLElement>("#banner"));
  private readonly empty = must(document.querySelector<HTMLElement>("#empty"));
  private readonly content = must(document.querySelector<HTMLElement>("#content"));
  private readonly statusMode = must(document.querySelector<HTMLElement>("#status-mode"));
  private readonly statusFile = must(document.querySelector<HTMLElement>("#status-file"));
  private readonly statusMsg = must(document.querySelector<HTMLElement>("#status-msg"));
  private readonly statusKeys = must(document.querySelector<HTMLElement>("#status-keys"));
  private readonly statusBar = must(document.querySelector<HTMLElement>(".win-status"));
  private readonly statusCmd = must(document.querySelector<HTMLInputElement>("#status-cmd"));
  private readonly statusCell = must(document.querySelector<HTMLElement>("#status-cell"));

  constructor(private readonly host: Host) {
    this.grid = new Grid(this.content, {
      onSelect: () => this.paintStatus(),
      onEdit: (row, col, value) => this.edit(row, col, value),
      onSay: (text, isError) => this.say(text, isError),
      onMode: (to) => {
        if (this.workspace !== undefined && this.workspace.mode !== to) this.toggleMode();
      },
      onEditor: () => this.paintStatus(),
      onPending: (keys) => {
        this.statusKeys.textContent = keys;
      },
      onShort: (wanted) => {
        const w = this.workspace;
        if (w === undefined) return;
        this.say(
          wanted === "end"
            ? `indexing ${w.indexed()}% · G again when it finishes`
            : `row ${(wanted + 1).toLocaleString()} is not indexed yet`,
        );
      },
      onAction: (action) => {
        switch (action.t) {
          case "undo":
            void this.undo();
            return;
          case "apply": {
            // From any cell, since the offer names its own column.
            const offer = this.offered();
            if (offer === null) this.say("nothing to apply", true);
            else void this.apply(offer);
            return;
          }
          case "dismiss": {
            const offer = this.offered();
            if (offer !== null) this.dismiss(offer);
            return;
          }
          case "prompt":
            this.prompt(action.lead);
            return;
        }
      },
    });

    this.wireDrop();
    this.wireKeys();
    this.wirePrompt();
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
      let opened: Workspace | undefined;
      engine.onProgress = () => this.repaint();
      engine.onError = (msg) => this.say(msg, true);
      engine.onOffer = (offer) => {
        if (opened === undefined || this.workspace !== opened) return;
        opened.offer = offer;
        this.paintBanner();
      };

      const w = await Workspace.open(ref, engine, savePath, () => this.repaint());
      if (open !== this.opens) {
        w.close(); // a later open finished first
        return;
      }
      opened = w;

      this.workspace?.close();
      this.workspace = w;
      this.dismissed = "";
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
    this.paintBanner();
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
    // Here rather than as menu accelerators, so the key reaches the page. The
    // cell editor stops its own keys, so these never fire while typing in one.
    window.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "e") {
        e.preventDefault();
        this.toggleMode();
      } else if (key === "z" && this.workspace?.editable === true) {
        e.preventDefault();
        void this.undo();
      }
    });
  }

  /**
   * toggleMode moves between view and transform.
   *
   * The switch is explicit because transform is where a keystroke changes the
   * file, and that should follow a decision to change it rather than a stray key
   * while scrolling. It loads nothing either way.
   */
  toggleMode(): void {
    const w = this.workspace;
    if (w === undefined) return;

    if (w.mode === "transform") w.view();
    else w.transform();

    this.grid.show(w.rows, w.editable, true);
    this.grid.focus();
    this.paintTabs();
    this.paintBanner();
    this.paintStatus();
  }

  // --------------------------------------------------------------- editing

  private edit(row: number, col: number, value: string): void {
    const w = this.workspace;
    if (w === undefined) return;

    w.set(row, col, value)
      .then(
        () => this.say(""),
        // The engine refuses a cell it will not let a person type into -- a bound
        // column, a row that is not there. Saying which is the whole point of it
        // refusing by name.
        (err: unknown) => this.say(message(err), true),
      )
      .finally(() => this.changed(w));
  }

  private async apply(offer: Offer): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    try {
      await w.apply(offer);
      this.say("");
    } catch (err) {
      this.say(message(err), true);
    }
    this.changed(w);
  }

  /** dismiss is Not now: the offer stays gone until it changes. */
  private dismiss(offer: Offer): void {
    this.dismissed = key(offer);
    this.paintBanner();
  }

  private async undo(): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    try {
      const undone = await w.undo();
      // One cell came back, so show it. An apply names a whole column and no row,
      // and the selection stays where it is.
      if (undone.row !== NO_ROW && this.workspace === w) this.grid.moveTo(undone.row, undone.col);
      this.say("");
    } catch (err) {
      this.say(message(err), true);
    }
    this.changed(w);
  }

  /** After an edit lands: kinds may have changed, and so has the log. */
  private changed(w: Workspace): void {
    if (this.workspace !== w) return;
    this.grid.refresh();
    this.paintTabs();
    this.paintBanner();
    this.paintStatus();
  }

  // ---------------------------------------------------------------- saving

  async save(): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    if (w.path === "") return this.saveAs();

    try {
      await this.host.save(w.path, await w.bytes(this.grid.selection()));
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
      const bytes = await w.bytes(this.grid.selection());
      const path = await this.host.saveAs(w.suggestedFileName, bytes);
      if (path === undefined) return; // cancelled
      w.saved(path);
      this.say(`saved ${path}`);
    } catch (err) {
      this.say(message(err), true);
    }
    this.paintTabs();
    this.paintStatus();
  }

  // ---------------------------------------------------------- command line

  /**
   * wirePrompt runs the one-line prompt in the status bar. Enter runs what was
   * typed and Esc closes it, as do clicking away and deleting the colon.
   */
  private wirePrompt(): void {
    const input = this.statusCmd;
    input.addEventListener("keydown", (e) => {
      // The grid's keys and the shell's chords stay out of what is being typed.
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        this.closePrompt();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const typed = input.value;
        this.closePrompt();
        this.run(command(typed.slice(1)));
      }
    });
    input.addEventListener("input", () => {
      if (!input.value.startsWith(":")) this.closePrompt();
    });
    input.addEventListener("blur", () => this.closePrompt());
  }

  private prompt(lead: ":"): void {
    this.statusBar.classList.add("prompting");
    this.statusCmd.hidden = false;
    this.statusCmd.value = lead;
    this.statusCmd.focus();
  }

  private closePrompt(): void {
    // Hidden first: handing the focus back blurs the input, which closes it again.
    if (this.statusCmd.hidden) return;
    this.statusCmd.hidden = true;
    this.statusBar.classList.remove("prompting");
    this.grid.focus();
  }

  /** run carries out a command from the prompt. */
  private run(c: Command): void {
    switch (c.t) {
      case "none":
        return;
      case "write":
        void this.save();
        return;
      case "save-as":
        void this.saveAs();
        return;
      case "open":
        // Opening closes the workspace without asking, so :e asks first.
        if (!c.force && this.workspace?.dirty === true) {
          this.say("unsaved edits · :w first, or :e! to drop them", true);
        } else {
          void this.open();
        }
        return;
      case "row":
        this.grid.act({ t: "move", motion: "last-row", count: c.row });
        return;
      case "unknown":
        this.say(`not a command: :${c.text}`, true);
        return;
    }
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
    seg.title = "i to transform · Esc to view · Ctrl+E";
    for (const [mode, label] of [
      ["view", "View"],
      ["transform", "Transform"],
    ] as const) {
      const option = document.createElement("span");
      option.textContent = label;
      if (w.mode === mode) option.className = mode === "view" ? "on" : "on t";
      else option.addEventListener("click", () => this.toggleMode());
      seg.append(option);
    }

    this.tabs.append(tab, grow, seg);
  }

  /** The offer the banner is asking about, or null while it is hidden. */
  private offered(): Offer | null {
    const w = this.workspace;
    const offer = w?.mode === "transform" ? w.offer : null;
    return offer === null || offer === undefined || this.dismissed === key(offer) ? null : offer;
  }

  /**
   * paintBanner asks the recogniser's question, in transform only.
   *
   * On a file larger than its first pass, the count grows while the survey
   * reads and says it is a lower bound. Apply works before the count is final:
   * it is one edit, and Ctrl+Z takes it back.
   */
  private paintBanner(): void {
    const offer = this.offered();
    if (offer === null) {
      this.banner.hidden = true;
      this.banner.replaceChildren();
      return;
    }

    const header = document.createElement("b");
    header.textContent = offer.header;

    const n = offer.affects.toLocaleString();
    const count = offer.complete
      ? `${n} ${offer.affects === 1 ? "cell" : "cells"}`
      : `at least ${n} in the first ${offer.scanned.toLocaleString()} rows`;
    const parts = [offer.description, count];
    if (offer.ambiguous) parts.push("another rule fits these examples too");

    const grow = document.createElement("span");
    grow.className = "grow";

    const apply = document.createElement("button");
    apply.className = "primary";
    apply.textContent = "Apply";
    // Both hand the keys back to the grid, or a j after the click would go nowhere.
    apply.addEventListener("click", () => {
      void this.apply(offer);
      this.grid.focus();
    });

    const later = document.createElement("button");
    later.textContent = "Not now";
    later.addEventListener("click", () => {
      this.dismiss(offer);
      this.grid.focus();
    });

    this.banner.replaceChildren(
      header,
      document.createTextNode(` · ${parts.join(" · ")}`),
      grow,
      apply,
      later,
    );
    this.banner.hidden = false;
  }

  private paintStatus(): void {
    const w = this.workspace;
    this.statusFile.textContent = w === undefined ? "no file open" : w.status();
    // INSERT is transform with the editor open, so it wears transform's amber.
    const mode = this.grid.editing() ? "INSERT" : w?.mode.toUpperCase();
    this.statusMode.textContent = mode ?? "";
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

/** An offer is the same question while its column and program are. */
function key(offer: Offer): string {
  return `${offer.col}:${offer.program}`;
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
  menu?.on("menu:mode", () => shell.toggleMode());
  menu?.onOpenPath((path) => void shell.openPath(path));

  document.querySelector("#open")?.addEventListener("click", () => void shell.open());
}
