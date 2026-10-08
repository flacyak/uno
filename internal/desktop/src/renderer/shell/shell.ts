// The shell: the sidebar, the banner, the grid, the status bar, and what the
// menu's keys mean.
//
// It owns *when* things happen and nothing about what they do. Opening a file
// is `Workspace.open` over an engine, adding one is `workspace.add`, changing a
// cell is `workspace.set`, saving is `workspace.bytes` handed to the host.
// Every one of those is testable without a window, which is the seam this file
// exists to keep.
//
// The grid is not loaded until the first file opens. The empty window has no use
// for it, or for its stylesheet.

import { Engine, messagePort } from "@uno/grid/engine";
import type { MessagePortLike, Offer, Reply, Request, SourceRef } from "@uno/grid/engine";
import { NO_ROW } from "@uno/grid/sheet";

import { covers } from "@uno/grid/library";
import type { Connection } from "@uno/grid/library";
import type { SingleRef } from "@uno/grid/store";
import { s3Location } from "@uno/grid/store/s3";

import { m } from "../../paraglide/messages.js";
import { columnLabel } from "../grid/rows.ts";
import type { Host } from "../../shared/host.ts";
import type { Grid, GridEvents } from "../grid/index.ts";
import { strategy } from "../input/index.ts";
import type { InputName, InputStrategy } from "../input/index.ts";
import { command } from "../keys.ts";
import { Language, offered } from "../language.ts";
import type { Command } from "../keys.ts";
import { list, num } from "../locale.ts";
import { Recents } from "../recents.ts";
import { say } from "../said.ts";
import { Sources, connectionLine } from "../sources.ts";
import type { Arriving } from "../sources.ts";
import { NEWER_AFTER_MS } from "../timing.ts";
import { Workspace, reloaded } from "../workspace.ts";
import type { Tab } from "../workspace.ts";
import { bannerParts, offerKey } from "./banner.ts";
import { wireDrop } from "./drop.ts";
import { Finder } from "./find.ts";
import type { Showing } from "./find.ts";
import { Theming } from "../theme.ts";
import { FormulaForm } from "./formula.ts";
import { PopMenu, below } from "./menu.ts";
import { labelPage } from "./page.ts";
import type { MenuItem, MenuPlace } from "./menu.ts";
import { Panel } from "./panel.ts";
import { Settings } from "./settings.ts";
import { sidebarRows } from "./sidebar.ts";
import type { SidebarActions } from "./sidebar.ts";
import { StatusBar } from "./status.ts";
import { baseName, message, must, settled } from "./util.ts";

/** Where the chosen input strategy is kept. It is this machine's choice, not a workspace's. */
const INPUT_KEY = "uno.input";

/** Where it is kept that the sidebar is closed. Open is what a new install gets. */
const SIDEBAR_KEY = "uno.sidebar";
const SIDEBAR_CLOSED = "closed";

/** What the window wears while the sidebar is closed. */
const NO_SIDEBAR = "no-sidebar";

/**
 * What would close the workspace without asking, so a warning about its
 * unsaved edits knows what it warned about: Ctrl+O, the window's ×, or a
 * workspace picked from the sidebar.
 */
type Dropping = "open" | "quit" | `recent:${string}`;

export class Shell {
  /** Told how keys are read whenever that changes, for whatever else shows it. */
  onInput: (name: InputName) => void = () => undefined;

  private workspace: Workspace | undefined;
  /** The grid, from the first open on. */
  private grid: Grid | undefined;
  private gridLoading: Promise<Grid> | undefined;
  /** Counts opens, so one that finishes after a later one does not replace it. */
  private opens = 0;
  /** The sources being opened, which the sidebar and the panel list until each has. */
  private arriving: readonly Arriving[] = [];
  /** The offer a person said "not now" to, so it stays gone until it changes. */
  private dismissed = "";
  /** What was warned about, for as long as the warning is on screen: the tab
   * its × would remove, or what would drop the workspace's unsaved edits. */
  private warned: Tab | Dropping | undefined;
  /** The save in flight, while one is: a second Ctrl+S joins it rather than
   * writing the same bytes twice, and the × waits for it to land. */
  private saving: Promise<void> | undefined;
  /** How keys are read, which the grid and the status bar both follow. */
  private input: InputStrategy = strategy(localStorage.getItem(INPUT_KEY));
  /** The menu hung off the sidebar, while one is open, and the formula form. */
  private menu: PopMenu | undefined;
  private formula: FormulaForm | undefined;
  /** Whether the sidebar is open, which is this machine's choice. */
  private sidebarOpen = localStorage.getItem(SIDEBAR_KEY) !== SIDEBAR_CLOSED;
  /** The workspaces the sidebar lists. */
  private readonly recents = new Recents(localStorage);
  /**
   * An engine that holds no workspace, for the panel while nothing is open.
   *
   * Browsing and the connections go through an engine, because the engine is
   * what holds the listers and the credentials. Before the first file there is
   * no workspace to own one, and "open a file first" is a poor answer to a
   * person who opened the panel to find that file. So one is started the first
   * time it is wanted, and closed once a workspace brings its own.
   */
  private spare: Promise<Engine> | undefined;
  /** What the last connections read said it could not read, so it is said once. */
  private connectionTrouble = "";
  /** The connections the engine last read, whole, for a new one's id to avoid. */
  private known: readonly Connection[] = [];

  private readonly status: StatusBar;
  private readonly finder: Finder;
  private readonly sources: Sources;
  private readonly panel: Panel;
  /** The theme the page wears, which the settings menu changes. */
  readonly theming: Theming;
  /** The language the app speaks, which the settings menu changes. */
  readonly language: Language;

  private readonly root = must(document.querySelector<HTMLElement>("#app"));
  private readonly workspaces = must(document.querySelector<HTMLElement>("#workspaces"));
  private readonly banner = must(document.querySelector<HTMLElement>("#banner"));
  private readonly empty = must(document.querySelector<HTMLElement>("#empty"));
  private readonly content = must(document.querySelector<HTMLElement>("#content"));

  constructor(private readonly host: Host) {
    // First of all, so every word written after it is in the language chosen.
    this.language = new Language(localStorage, navigator.languages, offered(import.meta.env.DEV));
    this.language.onChange(() => this.relabel());
    // The page's own words, before the rest is drawn beside them.
    labelPage();

    // First of what is drawn, so the page is in its theme before anything is drawn in it.
    this.theming = new Theming(
      localStorage,
      window.matchMedia("(prefers-color-scheme: dark)"),
      document.documentElement,
    );

    this.status = new StatusBar(
      (lead, typed) => {
        if (lead === ":") this.run(command(typed));
        else this.finder.search(typed, lead === "/" ? 1 : -1);
      },
      () => this.grid?.focus(),
      {
        toggleMode: () => this.toggleMode(),
        toggleSidebar: () => this.toggleSidebar(),
        togglePanel: () => this.togglePanel(),
      },
    );
    this.finder = new Finder(
      () => this.showing(),
      (text, isError) => this.say(text, isError),
    );

    this.sources = new Sources(
      {
        // Browsing goes through an engine, which holds the listers and the
        // credentials. The page never lists anything itself.
        list: async (path, cursor) => (await this.browser()).list(path, cursor),
        peek: async (ref) => (await this.browser()).peek(ref),
      },
      () => this.workspace?.sources ?? [],
      [],
      () => this.panel.draw(),
      () => this.arriving,
    );
    this.panel = new Panel(
      must(document.querySelector<HTMLElement>("#panel")),
      this.sources,
      () => this.input.name,
      {
        select: (id) => this.withTab(id, (tab) => this.select(tab)),
        add: (refs) => this.addSources([...refs]),
        append: (id, files) => this.withTab(id, (tab) => void this.append(tab, files)),
        reload: (id) => this.withTab(id, (tab) => void this.reload(tab)),
        repoint: (id, ref) => this.withTab(id, (tab) => void this.pointAt(tab, ref)),
        remove: (id) => this.withTab(id, (tab) => void this.remove(tab)),
        closed: () => {
          this.paintTabs();
          this.paintStatus();
          this.grid?.focus();
        },
      },
      {
        profiles: async () => (await this.browser()).profiles(),
        tryConnection: async (c) => (await this.browser()).tryConnection(c),
        save: (c) => this.saveConnection(c),
        known: () => this.known,
      },
    );

    wireDrop(
      this.root,
      this.empty,
      (files) => {
        let refs: SourceRef[];
        try {
          refs = files.map((file) => this.host.dropped(file));
        } catch (err) {
          this.say(message(err), true);
          return;
        }
        // A dropped workspace saves with a dialog the first time. That is one
        // question, once, and it keeps a drop from quietly writing over a file
        // the person may have dragged out of somewhere they did not mean to.
        if (refs.length === 1 && isWorkspace(refs[0]!)) void this.load(refs[0]!, "");
        else void this.addSources(refs);
      },
      (text) => this.say(text, true),
    );
    // It wires itself to the control and asks through these, so the shell
    // holds nothing of it.
    const settings = must(document.querySelector<HTMLButtonElement>("#settings"));
    new Settings(settings, this.theming, this.language, {
      connections: async () => {
        await this.refreshConnections();
        return this.known.map(connectionLine);
      },
      browse: (c) => {
        this.showPanel();
        this.panel.browse(c);
      },
      connect: () => {
        this.showPanel();
        this.panel.connect();
      },
      closed: () => {
        if (!this.panel.open) this.grid?.focus();
      },
      input: () => this.input.name,
      setInput: (name) => this.setInput(name),
    });
    this.root.classList.toggle(NO_SIDEBAR, !this.sidebarOpen);
    must(document.querySelector<HTMLElement>("#new")).addEventListener(
      "click",
      () => void this.open(),
    );
    must(document.querySelector<HTMLElement>("#close")).addEventListener("click", () =>
      this.quit(),
    );
    this.wireKeys();
    // Coming back to the window is when a person has had the chance to change
    // something in a bucket, so it is when the buckets are asked.
    // It is when a folder has had the chance to grow, too.
    window.addEventListener(
      "focus",
      settled(NEWER_AFTER_MS, async () => {
        await Promise.all([this.askNewer(), this.sources.askGrown()]);
      }),
    );
    this.paintTabs();
    this.paintStatus();
  }

  /**
   * askNewer asks each remote source's bucket, one HEAD each, whether it holds
   * a newer version than the tab reads, and repaints whatever that changed.
   */
  private async askNewer(): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    if (!(await w.askNewer()) || this.workspace !== w) return;
    this.paintTabs();
    this.panel.draw();
    this.paintStatus();
  }

  /**
   * browser is the engine the panel asks: the open workspace's, or a spare one
   * while nothing is open.
   */
  private browser(): Promise<Engine> {
    const w = this.workspace;
    if (w !== undefined) return Promise.resolve(w.engine);
    this.spare ??= this.host.connect().then(
      (port) => this.engineOn(port),
      (err: unknown) => {
        this.spare = undefined; // so the next ask tries again
        throw err;
      },
    );
    return this.spare;
  }

  /** closeSpare stops the spare engine, once a workspace has one of its own. */
  private closeSpare(): void {
    const spare = this.spare;
    this.spare = undefined;
    void spare?.then((engine) => engine.close()).catch(() => undefined);
  }

  /**
   * refreshConnections asks the engine to read the connections again and
   * lists them in the panel: when the panel opens, when a workspace comes with
   * an engine of its own, and when one is saved.
   *
   * A file it could not read is said once, and not again every time the panel
   * opens over the same broken file.
   */
  private async refreshConnections(): Promise<void> {
    try {
      const { connections, failed } = await (await this.browser()).connections();
      this.known = connections;
      this.sources.connections = connections.map(connectionLine);
      this.panel.draw();
      const trouble = failed.map(say).join(" · ");
      if (trouble !== this.connectionTrouble) {
        this.connectionTrouble = trouble;
        if (trouble !== "") this.say(trouble, true);
      }
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /**
   * saveConnection keeps a connection and has the engine read them again, so
   * it is listed and signed with at once, without a restart.
   */
  async saveConnection(c: Connection): Promise<Connection> {
    const saved = await this.host.saveConnection(c);
    await this.refreshConnections();
    // The tabs that were waiting for this connection are read now: the person
    // connecting the bucket is the person saying it may be read.
    for (const tab of this.workspace?.sources ?? []) {
      const path = tab.link?.path;
      if (path === undefined || tab.link?.connect === undefined) continue;
      const loc = s3Location(path);
      if (loc !== undefined && covers(saved, loc.bucket, loc.key)) {
        void this.pointAt(tab, refAt(path), () =>
          m.source_reads_from({ name: tab.name, from: saved.name }),
        );
      }
    }
    return saved;
  }

  /** The open tab with this id, which is how the panel names one. */
  private tabAt(id: string): Tab | undefined {
    return this.workspace?.sources.find((t) => t.id === id);
  }

  /** The open workspace and the grid showing it, or undefined before a file opens. */
  private showing(): Showing | undefined {
    const workspace = this.workspace;
    const grid = this.grid;
    return workspace === undefined || grid === undefined ? undefined : { workspace, grid };
  }

  // --------------------------------------------------------------- opening

  /**
   * drops says whether `what` may go ahead, given that it closes the workspace
   * without asking. Over unsaved edits the first try says so and is refused.
   * The second, while that is still on screen, goes ahead, as :e! does.
   */
  private drops(what: Dropping): boolean {
    if (this.workspace?.dirty !== true || this.warned === what) return true;
    this.say(
      what === "open"
        ? m.unsaved_edits_key_again({ key: "Ctrl+O" })
        : what === "quit"
          ? m.unsaved_edits_key_again({ key: "×" })
          : m.unsaved_edits_click_again(),
      true,
    );
    this.warned = what;
    return false;
  }

  /**
   * open asks for a file and opens it in place of the one open now: Ctrl+O,
   * and the + at the foot of the sidebar. A spreadsheet opens as a new
   * workspace, and a .uno as the one it is.
   *
   * `force` is :e!, and :e, which has asked already.
   */
  async open(force = false): Promise<void> {
    if (!force && !this.drops("open")) return;
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
    await this.load(refAt(path), path);
  }

  /**
   * openRecent opens a workspace from the sidebar, and answers whether it is
   * the one open afterwards. One that will not open says why and stays
   * listed, since a folder that is not mounted today is there tomorrow.
   */
  private async openRecent(path: string): Promise<boolean> {
    if (this.workspace?.path === path) return true;
    if (!this.drops(`recent:${path}`)) return false;
    await this.load(refAt(path), path);
    return this.workspace?.path === path;
  }

  /**
   * Whether closing now would lose something: what a page asks before a
   * browser lets its tab go, where there is no × of uno's own to ask twice.
   */
  get unsaved(): boolean {
    return this.workspace?.dirty === true;
  }

  /**
   * quit closes the window, from the × at its top right. Over unsaved edits
   * the first × says so, as Ctrl+O does.
   */
  quit(): void {
    if (this.saving !== undefined) {
      void this.saving.then(() => this.quit());
      return;
    }
    if (this.drops("quit")) this.host.quit();
  }

  /** Add files by path, as sources: several named together on the command line. */
  async addPaths(paths: string[]): Promise<void> {
    await this.addSources(paths.map(refAt));
  }

  /** add asks for files and adds them to the open workspace, or opens them as one. */
  async add(): Promise<void> {
    try {
      const refs = await this.host.add();
      if (refs.length > 0) await this.addSources(refs);
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /** offer hangs a menu off the page, in place of any already there. */
  private offer(place: MenuPlace, items: readonly MenuItem[]): void {
    this.menu?.close();
    this.formula?.close();
    this.menu = new PopMenu(place, items, () => {
      this.menu = undefined;
      this.grid?.focus();
    });
  }

  /**
   * offerAdd opens the + menu: a file off this machine, or the sources panel,
   * where an object in S3 is browsed to or its address pasted into the filter.
   */
  private offerAdd(plus: HTMLElement): void {
    this.offer(below(plus), [
      { label: m.menu_file(), keys: "Ctrl+Shift+O", choose: () => void this.add() },
      { label: m.menu_browse_sources(), keys: "Ctrl+Shift+B", choose: () => this.showPanel() },
    ]);
  }

  /**
   * offerWorkspace is a right click on a workspace in the sidebar: a formula
   * into it, and what else is done to a workspace as a whole. One that is not
   * open is opened first by whatever needs it open. `path` is "" for the open
   * workspace while it has never been saved.
   */
  private offerWorkspace(path: string, place: MenuPlace): void {
    const isOpen = this.workspace !== undefined && this.workspace.path === path;
    const formula: MenuItem = {
      label: m.menu_insert_formula(),
      choose: () => void this.insertFormula(path, place),
    };
    const forget: MenuItem = {
      label: m.menu_remove_from_list(),
      choose: () => {
        this.recents.forget(path);
        this.paintTabs();
      },
    };
    const items: MenuItem[] = isOpen
      ? [
          formula,
          { label: m.menu_add_source(), keys: "Ctrl+Shift+O", choose: () => void this.add() },
          { label: m.menu_save(), keys: "Ctrl+S", choose: () => void this.save() },
          { label: m.menu_save_as(), keys: "Ctrl+Shift+S", choose: () => void this.saveAs() },
        ]
      : [{ label: m.menu_open(), choose: () => void this.openRecent(path) }, formula, forget];
    this.offer(place, items);
  }

  /**
   * insertFormula opens the formula form on the source showing in a workspace,
   * opening the workspace first when it is another one. The form opens where
   * the workspace was right-clicked.
   */
  private async insertFormula(path: string, place: MenuPlace): Promise<void> {
    if (!(await this.openRecent(path))) return;
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;
    const tab = w.active;
    if (tab.missing) {
      this.say(m.source_no_file_point_first({ name: tab.name }), true);
      return;
    }

    this.menu?.close();
    this.formula?.close();
    this.formula = new FormulaForm(place, tab.name, tab.band.columns, grid.selection().col, {
      insert: (col, expr) => this.bind(w, tab, col, expr),
      closed: () => {
        this.formula = undefined;
        this.grid?.focus();
      },
    });
  }

  /**
   * bind computes a column from an expression. A formula changes the file, so
   * it is made in transform, and asking for one is the decision to be there.
   * What the engine refuses is thrown for the form to say.
   */
  private async bind(w: Workspace, tab: Tab, col: number, expr: string): Promise<void> {
    if (this.workspace !== w || !w.sources.includes(tab)) {
      throw new Error(m.source_no_longer_open({ name: tab.name }));
    }
    if (w.mode !== "transform") this.toggleMode();
    try {
      await w.bind(tab, col, expr);
    } finally {
      this.changed(w);
    }
    // The column it went into is selected, as undo selects the cell it
    // changed, which also brings a column off the side of the window on screen.
    const on = this.showing();
    if (on?.workspace === w && w.active === tab) on.grid.moveTo(on.grid.selection().row, col);
    const column = tab.band.columns[col];
    this.say(
      m.column_computed_from({
        column: column === undefined ? m.the_column() : columnLabel(column.header, col),
        expr,
      }),
    );
  }

  /**
   * addSources puts files in the open workspace as sources, beside the ones
   * already there, and shows the last. With no workspace open the first file
   * opens one. A .uno is a workspace of its own, so it is refused by name.
   * It answers whether every one of them opened.
   */
  private async addSources(refs: SourceRef[]): Promise<boolean> {
    const uno = refs.find(isWorkspace);
    if (uno !== undefined) {
      this.say(m.workspace_not_a_source({ name: uno.name }), true);
      return false;
    }

    // Each is listed in the sidebar and in the panel as opening from now
    // until it has opened or been refused, in the order they are opened in.
    const coming = refs.map((ref): Arriving => ({ name: ref.name }));
    this.arriving = [...this.arriving, ...coming];
    this.paintTabs();
    const settled = (): void => {
      const line = coming.shift();
      this.arriving = this.arriving.filter((a) => a !== line);
      this.paintTabs();
    };
    try {
      return await this.addEach(refs, settled);
    } finally {
      // Whatever was never reached -- another open took the workspace's place.
      while (coming.length > 0) settled();
    }
  }

  /**
   * addEach opens the files one after another and says `settled` as each one
   * has opened or been refused. It answers whether every one of them opened.
   */
  private async addEach(refs: SourceRef[], settled: () => void): Promise<boolean> {
    let rest = refs;
    if (this.workspace === undefined) {
      const [first, ...others] = refs;
      if (first === undefined) return false;
      await this.load(first, "");
      settled();
      rest = others;
    }
    const w = this.workspace;
    if (w === undefined) return false;
    if (rest.length === 0) {
      // Files added as one may already have more beside them.
      void this.sources.askGrown();
      return true;
    }

    let shown: Tab | undefined;
    const failed: string[] = [];
    for (const ref of rest) {
      try {
        shown = await w.add(ref);
      } catch (err) {
        failed.push(message(err));
      }
      settled();
    }
    if (this.workspace !== w) return false; // another open replaced it meanwhile

    if (shown !== undefined) this.select(shown);
    else this.paintTabs();
    if (failed.length > 0) this.say(failed.join(" · "), true);
    else this.say(m.added_names({ names: list(rest.map((r) => r.name)) }));
    void this.sources.askGrown();
    return failed.length === 0;
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
      engine = this.engineOn(await this.host.connect());
      let opened: Workspace | undefined;

      const w = await Workspace.open(
        ref,
        engine,
        savePath,
        () => this.repaint(),
        (tab) => {
          // Only the question about the source showing is asked.
          if (opened !== undefined && this.workspace === opened && opened.active === tab) {
            this.paintBanner();
          }
        },
      );
      if (open !== this.opens) {
        w.close(); // a later open finished first
        return;
      }
      opened = w;

      this.workspace?.close();
      this.workspace = w;
      // A menu or a form left open was about the workspace this one replaces.
      this.menu?.close();
      this.formula?.close();
      if (w.path !== "") this.recents.opened(w.path);
      // The workspace's engine answers the panel from here on.
      this.closeSpare();
      void this.refreshConnections();
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
    this.paintAll();
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
            ? m.indexing_g_again({ percent: w.indexed() })
            : m.row_not_indexed({ row: num(wanted + 1) }),
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
            if (offer === null) this.say(m.nothing_to_apply(), true);
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
          case "tab": {
            const w = this.workspace;
            if (w === undefined) return;
            // 3gt is the third tab, as in vim. A count past the last goes nowhere.
            const to =
              action.step === 1 && action.count !== undefined
                ? w.sources[action.count - 1]
                : w.beside(action.step * (action.count ?? 1));
            if (to !== undefined) this.select(to);
            return;
          }
        }
      },
    };
  }

  // ----------------------------------------------------------------- modes

  private wireKeys(): void {
    // Here rather than as menu accelerators, so the key reaches the page. The
    // cell editor stops its own keys, so these never fire while typing in one.
    window.addEventListener("keydown", (e) => {
      // A key the grid read is not read again here: Ctrl+B pages up under
      // vim-style, and the sidebar stays as it is.
      if (e.defaultPrevented) return;
      // Ctrl+PageDown and Ctrl+PageUp are how a browser or an editor moves between
      // tabs, and Ctrl+Tab too. Neither input strategy reads them.
      if (e.ctrlKey && !e.altKey && !e.metaKey && this.workspace !== undefined) {
        const step =
          e.key === "PageDown" || (e.key === "Tab" && !e.shiftKey)
            ? 1
            : e.key === "PageUp" || (e.key === "Tab" && e.shiftKey)
              ? -1
              : 0;
        if (step !== 0) {
          e.preventDefault();
          this.select(this.workspace.beside(step));
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey) {
        if (key === "b") {
          e.preventDefault();
          this.showPanel();
        }
        return;
      }
      if (key === "b") {
        e.preventDefault();
        this.toggleSidebar();
      } else if (key === "e") {
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
    this.paintAll();
  }

  // ------------------------------------------------------------------ tabs

  /**
   * toggleSidebar opens the sidebar, or closes it so the grid has the width:
   * Ctrl+B, and the switch at the left of the status bar. The choice is kept,
   * so the next launch opens the same way.
   */
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    localStorage.setItem(SIDEBAR_KEY, this.sidebarOpen ? "open" : SIDEBAR_CLOSED);
    this.root.classList.toggle(NO_SIDEBAR, !this.sidebarOpen);
    this.menu?.close();
    this.formula?.close();
    this.grid?.repaint();
    this.paintStatus();
  }

  /**
   * togglePanel opens the sources panel beside the grid, or closes it. The
   * grid gives up the width and keeps its rows, so it is laid out again and
   * nothing is fetched.
   */
  togglePanel(): void {
    this.panel.toggle();
    // A connection saved in another window, or put in the folder by hand, is
    // listed the next time the panel opens, and so is what a folder gained.
    if (this.panel.open) this.refreshPanel();
    this.paintTabs();
    this.paintStatus();
    this.grid?.repaint();
  }

  /**
   * showPanel opens the sources panel with the keys in it: the + menu's
   * Browse sources…, Ctrl+Shift+B and :sources. Open already, it only takes
   * the keys back, so a second Ctrl+Shift+B is not a close.
   */
  showPanel(): void {
    if (this.panel.open) {
      this.panel.show();
      this.refreshPanel();
      return;
    }
    this.togglePanel();
  }

  /** refreshPanel asks again for what the panel shows that it does not own:
   * the connections, and the files each tab of several could append. */
  private refreshPanel(): void {
    void this.refreshConnections();
    void this.sources.askGrown();
  }

  /**
   * select shows another source. The grid it leaves remembers where it was, and
   * the one it shows goes back to where it was left. The tab already showing
   * stays as it is, marks and all.
   */
  private select(tab: Tab): void {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;
    if (w.active !== tab) {
      w.active.cell = grid.selection();
      w.show(tab);
      this.showActive();
    }
    grid.focus();
  }

  /** showActive draws the tab the workspace says is showing, where it was left. */
  private showActive(): void {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;
    grid.show(w.rows, w.editable);
    grid.moveTo(w.active.cell.row, w.active.cell.col);
    this.paintAll();
  }

  /**
   * remove takes a source out of the workspace. One with edits goes on the
   * second ×, since its edits go with it and the log is the only place they
   * were.
   */
  private async remove(tab: Tab): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    if (tab.edited > 0 && this.warned !== tab) {
      this.say(m.source_has_edits({ name: tab.name, count: tab.edited }), true);
      this.warned = tab;
      return;
    }
    try {
      // Whether the tab was on screen is the workspace's answer, not a look
      // taken before asking: Ctrl+Tab pressed meanwhile moves what is.
      const showing = await w.remove(tab);
      if (this.workspace !== w) return;
      this.say(m.removed_name({ name: tab.name }));
      // Taking out the tab on screen puts its neighbour there.
      this.shown(showing);
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /**
   * repoint is a tab's ! mark: the panel opens picking a file for it, from the
   * browser, so a source in S3 is pointed at another object and not only at
   * whatever the local file dialog can reach.
   */
  private repoint(tab: Tab): void {
    if (!this.panel.open) this.togglePanel();
    // A tab in a bucket nobody connected is not fixed by another file: its
    // mark asks to connect the bucket, filled in.
    if (tab.link?.connect !== undefined) this.panel.connectFor(tab.id);
    // One whose bucket holds a newer version has its answer on its own line:
    // Reload reads it.
    else if (tab.newer !== undefined && !tab.missing) this.panel.showTab(tab.id);
    else this.panel.repoint(tab.id);
  }

  /**
   * reload reads a tab's file again from where it already points, which is a
   * re-point at the same path: the log replays over whatever is there now. A
   * file that came back after going missing is found again the same way. It
   * asks for no version, so an object is read as its bucket holds it now --
   * the newer one a mark said was there, or the newest after a pinned one --
   * and it says what it found.
   */
  private async reload(tab: Tab): Promise<void> {
    const path = tab.link?.path;
    if (path === undefined) return;
    await this.pointAt(tab, refAt(path), (fresh) => reloaded(tab, fresh));
  }

  /**
   * pointAt points a tab at a file, from the panel's browser or its reload.
   * The edits replay over the file; one that cannot take them is refused and
   * the tab is left as it was.
   */
  private async pointAt(tab: Tab, ref: SourceRef, said?: (fresh: Tab) => string): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    try {
      const fresh = await w.relink(tab, ref);
      if (this.workspace !== w) return;

      // A tab that waited for its bucket stops waiting once it is connected,
      // read or not. One that still has no file says why on its own line, so
      // the message beside it would only say it twice.
      this.say(
        fresh.missing
          ? ""
          : (said?.(fresh) ??
              m.source_reads_from({ name: fresh.name, from: "path" in ref ? ref.path : ref.name })),
      );
      this.shown(w.active === fresh);
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /**
   * append adds the files a tab's folder has gained at its end, from the
   * panel's offer. The rows extend and the edits stay on the cells they were
   * made to; files that do not read the way the tab's first does are refused
   * and the tab is left as it was.
   */
  private async append(tab: Tab, files: readonly SingleRef[]): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    try {
      const fresh = await w.append(tab, files);
      if (this.workspace !== w) return;
      this.say(m.appended_to({ files: list(files.map((f) => f.name)), name: fresh.name }));
      this.shown(w.active === fresh);
    } catch (err) {
      this.say(message(err), true);
    }
    // What was offered is appended, or was refused and may be offered again.
    void this.sources.askGrown();
  }

  // ----------------------------------------------------------------- input

  /** The input strategy reading keys now, for the Edit menu to check. */
  get inputName(): InputName {
    return this.input.name;
  }

  /**
   * setInput changes how keys are read, from settings or Edit → Input. The
   * choice is kept in the page's storage, so the next launch reads keys the
   * same way.
   */
  setInput(name: string): void {
    this.input = strategy(name);
    localStorage.setItem(INPUT_KEY, this.input.name);
    this.onInput(this.input.name);
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
    // The edit is the showing tab's, and so is the cell it changed: one the
    // person has since left is not moved to in the other.
    const tab = w.active;
    try {
      const edit = await (which === "undo" ? w.undo() : w.redo());
      // One cell came back, so show it. An apply names a whole column and no row,
      // and the selection stays where it is.
      const on = this.showing();
      if (edit.row !== NO_ROW && on?.workspace === w && w.active === tab) {
        on.grid.moveTo(edit.row, edit.col);
      }
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
    this.paintAll();
  }

  // ---------------------------------------------------------------- saving

  /**
   * save writes the workspace where it was saved last, and asks where the
   * first time. One save at a time: a second Ctrl+S while one is in flight,
   * or at its dialog, joins it rather than writing the same bytes twice or
   * asking twice.
   */
  save(): Promise<void> {
    return this.saveTo((w) => (w.path === "" ? undefined : w.path));
  }

  /**
   * saveAs asks where first, then lays the workspace out for that folder.
   *
   * That order is the whole reason the dialog and the write are two calls: a
   * source beside the workspace is pointed at relative to it, so what gets
   * written depends on where it is going.
   */
  saveAs(): Promise<void> {
    return this.saveTo(() => undefined);
  }

  /** saveTo is one save at a time, of the workspace showing, to the path `where` picks for it. */
  private saveTo(where: (w: Workspace) => string | undefined): Promise<void> {
    if (this.saving !== undefined) return this.saving;
    const on = this.showing();
    if (on === undefined) return Promise.resolve();
    this.saving = this.write(on, where(on.workspace));
    return this.saving;
  }

  /**
   * write is the save itself: the dialog when `path` is not known, the bytes,
   * the host, the paint. A place the workspace reads a source from is refused
   * before a byte goes out: the dialog asked about replacing a file, not
   * about losing a source.
   */
  private async write(on: Showing, path: string | undefined): Promise<void> {
    const { workspace: w, grid } = on;
    try {
      const at = path ?? (await this.host.pickSave(w.suggestedFileName));
      if (at === undefined) return; // cancelled
      const over = w.readingFrom(at);
      if (over !== undefined) {
        this.say(m.save_over_source({ name: over.name }), true);
        return;
      }
      await this.host.save(at, await w.bytes(grid.selection(), at));
      w.saved(at);
      this.recents.opened(at);
      this.say(m.saved_path({ path: at }));
    } catch (err) {
      this.say(message(err), true);
    } finally {
      this.saving = undefined;
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
          this.say(m.unsaved_edits_command(), true);
        } else {
          void this.open(true);
        }
        return;
      case "sources":
        this.showPanel();
        return;
      case "row":
        this.grid?.act({ t: "move", motion: "last-row", count: c.row });
        return;
      case "unknown":
        this.say(m.not_a_command({ text: c.text }), true);
        return;
    }
  }

  // -------------------------------------------------------------- painting

  /** Rows landed or the index moved: the body and the status bar, nothing else. */
  private repaint(): void {
    this.grid?.repaint();
    this.paintStatus();
  }

  /**
   * relabel writes the window again in the language the app is in now, with
   * everything open left open. What is painted is painted again, and what was
   * written once is written again.
   */
  private relabel(): void {
    labelPage();
    // A menu or a form left open was built in the language before.
    this.menu?.close();
    this.formula?.close();
    // So was what the bar last said, and a sentence is not translated after it is said.
    this.say("");
    this.panel.relabel();
    // The header's hints, which the grid draws once for a file.
    this.grid?.refresh();
    this.paintAll();
  }

  /** withTab does something to the tab an id names, where the workspace still has it. */
  private withTab(id: string, act: (tab: Tab) => void): void {
    const tab = this.tabAt(id);
    if (tab !== undefined) act(tab);
  }

  /** engineOn is an engine over a port, with what it says unasked said in the status bar. */
  private engineOn(port: MessagePortLike): Engine {
    const engine = new Engine(messagePort<Reply, Request>(port));
    engine.onError = (heard) => this.say(say(heard), true);
    return engine;
  }

  /**
   * shown repaints after a tab changed: the grid where it is the one showing,
   * the sidebar where it is not, and the status bar either way.
   */
  private shown(showing: boolean): void {
    if (showing) this.showActive();
    else this.paintTabs();
    this.paintStatus();
  }

  /** paintAll draws everything the shell paints: the sidebar, the banner and the status bar. */
  private paintAll(): void {
    this.paintTabs();
    this.paintBanner();
    this.paintStatus();
  }

  /** paintTabs draws the sidebar: the workspaces, and the open one's tabs. */
  private paintTabs(): void {
    const act: SidebarActions = {
      open: (path) => void this.openRecent(path),
      menu: (path, place) => this.offerWorkspace(path, place),
      select: (tab) => this.select(tab),
      remove: (tab) => void this.remove(tab),
      add: (plus) => this.offerAdd(plus),
      repoint: (tab) => this.repoint(tab),
    };
    this.workspaces.replaceChildren(
      ...sidebarRows(this.workspace, this.recents.all, act, this.arriving),
    );
    // The panel lists the tabs too, and whatever changed the sidebar changed them.
    this.panel.draw();
  }

  /** The offer the banner is asking about, or null while it is hidden. */
  private offered(): Offer | null {
    const offer = this.workspace?.offer ?? null;
    return offer === null || this.dismissed === offerKey(offer) ? null : offer;
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
    this.status.paint(this.workspace, this.grid, this.input, {
      sidebar: this.sidebarOpen,
      panel: this.panel.open,
    });
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

/** isWorkspace says whether a file is a .uno, which opens as a workspace of its own. */
function isWorkspace(ref: SourceRef): boolean {
  // Several files read as one are a source whatever they are called.
  return !("parts" in ref) && ref.name.toLowerCase().endsWith(".uno");
}

/** refAt names a file by path the way a dialog would have. */
function refAt(path: string): SourceRef {
  return { name: baseName(path), path };
}
