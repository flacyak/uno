// The shell: the tab strip, the banner, the grid, the status bar, and what the
// menu means.
//
// It owns *when* things happen and nothing about what they do. Opening a file
// is `Workspace.open` over an engine, changing a cell is `workspace.set`, saving
// is `workspace.bytes` handed to the host. Every one of those is testable
// without a window, which is the seam this file exists to keep.
//
// The grid is not loaded until the first file opens. The empty window has no use
// for it, or for its stylesheet.

import { Engine, messagePort } from "@uno/grid/engine";
import type { MessagePortLike, Offer, Reply, Request, SourceRef } from "@uno/grid/engine";
import { NO_ROW } from "@uno/grid/sheet";

import type { Host } from "../../shared/host.ts";
import type { Grid, GridEvents } from "../grid/index.ts";
import { strategy } from "../input/index.ts";
import type { InputName, InputStrategy } from "../input/index.ts";
import { command } from "../keys.ts";
import type { Command } from "../keys.ts";
import { Workspace } from "../workspace.ts";
import { bannerParts, offerKey } from "./banner.ts";
import { wireDrop } from "./drop.ts";
import { Finder } from "./find.ts";
import type { Showing } from "./find.ts";
import { StatusBar } from "./status.ts";
import { tabStrip } from "./tabs.ts";
import { message, must } from "./util.ts";

/** Where the chosen input strategy is kept. It is this machine's choice, not a workspace's. */
const INPUT_KEY = "uno.input";

export class Shell {
  private workspace: Workspace | undefined;
  /** The grid, from the first open on. */
  private grid: Grid | undefined;
  private gridLoading: Promise<Grid> | undefined;
  /** Counts opens, so one that finishes after a later one does not replace it. */
  private opens = 0;
  /** The offer a person said "not now" to, so it stays gone until it changes. */
  private dismissed = "";
  /** The workspace Ctrl+O warned about, for as long as the warning is on screen. */
  private warned: Workspace | undefined;
  /** How keys are read, which the grid and the status bar both follow. */
  private input: InputStrategy = strategy(localStorage.getItem(INPUT_KEY));

  private readonly status: StatusBar;
  private readonly finder: Finder;

  private readonly root = must(document.querySelector<HTMLElement>("#app"));
  private readonly tabs = must(document.querySelector<HTMLElement>("#tabs"));
  private readonly banner = must(document.querySelector<HTMLElement>("#banner"));
  private readonly empty = must(document.querySelector<HTMLElement>("#empty"));
  private readonly content = must(document.querySelector<HTMLElement>("#content"));

  constructor(private readonly host: Host) {
    this.status = new StatusBar(
      (lead, typed) => {
        if (lead === ":") this.run(command(typed));
        else this.finder.search(typed, lead === "/" ? 1 : -1);
      },
      () => this.grid?.focus(),
    );
    this.finder = new Finder(
      () => this.showing(),
      (text, isError) => this.say(text, isError),
    );

    wireDrop(
      this.root,
      this.empty,
      (file) => {
        try {
          // A dropped workspace saves with a dialog the first time. That is one
          // question, once, and it keeps a drop from quietly writing over a file
          // the person may have dragged out of somewhere they did not mean to.
          void this.load(this.host.dropped(file), "");
        } catch (err) {
          this.say(message(err), true);
        }
      },
      (text) => this.say(text, true),
    );
    this.wireKeys();
    this.paintStatus();
  }

  /** The open workspace and the grid showing it, or undefined before a file opens. */
  private showing(): Showing | undefined {
    const workspace = this.workspace;
    const grid = this.grid;
    return workspace === undefined || grid === undefined ? undefined : { workspace, grid };
  }

  // --------------------------------------------------------------- opening

  /**
   * open asks for a file and opens it in place of the one open now.
   *
   * Opening closes the workspace without asking, so over unsaved edits the
   * first Ctrl+O says so. A second, while that is still on screen, opens anyway,
   * as :e! does. `force` is :e!, and :e, which has asked already.
   */
  async open(force = false): Promise<void> {
    const w = this.workspace;
    if (!force && w?.dirty === true && this.warned !== w) {
      this.say("unsaved edits · Ctrl+S first, or Ctrl+O again to drop them", true);
      this.warned = w;
      return;
    }
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
      // Before the engine, so a grid that fails to load leaves no engine running.
      const grid = await this.loadGrid();
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
      grid.show(w.rows, w.editable);
      this.empty.hidden = true;
      this.content.hidden = false;
      grid.focus();
      this.say("");
    } catch (err) {
      engine?.close();
      if (open === this.opens) this.say(message(err), true);
    }
    this.paintTabs();
    this.paintBanner();
    this.paintStatus();
  }

  /** loadGrid fetches the grid and its stylesheet the first time a file opens. */
  private loadGrid(): Promise<Grid> {
    this.gridLoading ??= import("../grid/index.ts").then(
      ({ Grid }) => {
        this.grid = new Grid(this.content, this.gridEvents(), this.input);
        return this.grid;
      },
      (err: unknown) => {
        this.gridLoading = undefined; // so the next open tries again
        throw err;
      },
    );
    return this.gridLoading;
  }

  private gridEvents(): GridEvents {
    return {
      onSelect: () => this.paintStatus(),
      onEdit: (row, col, value) => this.edit(row, col, value),
      onSay: (text, isError) => this.say(text, isError),
      onMode: (to) => {
        if (this.workspace !== undefined && this.workspace.mode !== to) this.toggleMode();
      },
      onEditor: () => this.paintStatus(),
      onPending: (keys) => this.status.keys(keys),
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
            void this.history("undo");
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
            this.status.prompt(action.lead);
            return;
          case "unparsed":
            this.finder.unparsed(action.dir);
            return;
          case "next":
            this.finder.next(action.reverse);
            return;
          case "redo":
            void this.history("redo");
            return;
        }
      },
    };
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
        void this.history("undo");
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
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;

    if (w.mode === "transform") w.view();
    else w.transform();

    grid.show(w.rows, w.editable, true);
    grid.focus();
    this.paintTabs();
    this.paintBanner();
    this.paintStatus();
  }

  // ----------------------------------------------------------------- input

  /** The input strategy reading keys now, for the Edit menu to check. */
  get inputName(): InputName {
    return this.input.name;
  }

  /**
   * setInput changes how keys are read, from Edit → Input. The choice is kept in
   * the page's storage, so the next launch reads keys the same way.
   */
  setInput(name: string): void {
    this.input = strategy(name);
    localStorage.setItem(INPUT_KEY, this.input.name);
    this.status.close();
    this.grid?.setInput(this.input);
    this.grid?.focus();
    this.paintTabs();
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
    this.dismissed = offerKey(offer);
    this.paintBanner();
  }

  /** history takes the last edit back, or records again the one undo last took back. */
  private async history(which: "undo" | "redo"): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    try {
      const edit = await (which === "undo" ? w.undo() : w.redo());
      // One cell came back, so show it. An apply names a whole column and no row,
      // and the selection stays where it is.
      const on = this.showing();
      if (edit.row !== NO_ROW && on?.workspace === w) on.grid.moveTo(edit.row, edit.col);
      this.say("");
    } catch (err) {
      this.say(message(err), true);
    }
    this.changed(w);
  }

  /** After an edit lands: kinds may have changed, and so has the log. */
  private changed(w: Workspace): void {
    const on = this.showing();
    if (on?.workspace !== w) return;
    on.grid.refresh();
    this.paintTabs();
    this.paintBanner();
    this.paintStatus();
  }

  // ---------------------------------------------------------------- saving

  async save(): Promise<void> {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;
    if (w.path === "") return this.saveAs();

    try {
      await this.host.save(w.path, await w.bytes(grid.selection()));
      w.saved(w.path);
      this.say(`saved ${w.path}`);
    } catch (err) {
      this.say(message(err), true);
    }
    this.paintTabs();
    this.paintStatus();
  }

  async saveAs(): Promise<void> {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;

    try {
      const bytes = await w.bytes(grid.selection());
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
          void this.open(true);
        }
        return;
      case "row":
        this.grid?.act({ t: "move", motion: "last-row", count: c.row });
        return;
      case "unknown":
        this.say(`not a command: :${c.text}`, true);
        return;
    }
  }

  // -------------------------------------------------------------- painting

  /** Rows landed or the index moved: the body and the status bar, nothing else. */
  private repaint(): void {
    this.grid?.repaint();
    this.paintStatus();
  }

  private paintTabs(): void {
    const w = this.workspace;
    const strip =
      w === undefined ? [] : tabStrip(w, this.input.switchHint, () => this.toggleMode());
    this.tabs.replaceChildren(...strip);
  }

  /** The offer the banner is asking about, or null while it is hidden. */
  private offered(): Offer | null {
    const w = this.workspace;
    const offer = w?.mode === "transform" ? w.offer : null;
    return offer === null || offer === undefined || this.dismissed === offerKey(offer)
      ? null
      : offer;
  }

  /** paintBanner asks the recogniser's question, in transform only. */
  private paintBanner(): void {
    const offer = this.offered();
    if (offer === null) {
      this.banner.hidden = true;
      this.banner.replaceChildren();
      return;
    }

    // Both hand the keys back to the grid, or a j after the click would go nowhere.
    const apply = (): void => {
      void this.apply(offer);
      this.grid?.focus();
    };
    const later = (): void => {
      this.dismiss(offer);
      this.grid?.focus();
    };
    this.banner.replaceChildren(...bannerParts(offer, apply, later));
    this.banner.hidden = false;
  }

  private paintStatus(): void {
    this.status.paint(this.workspace, this.grid, this.input);
  }

  /** One line, and the only place the shell talks. An error stays until the
   * next thing happens, so it cannot be missed by blinking. */
  private say(text: string, isError = false): void {
    // Whatever is said next replaces Ctrl+O's warning, and a second Ctrl+O
    // opens only while the warning is there to be read.
    this.warned = undefined;
    this.status.say(text, isError);
  }
}
