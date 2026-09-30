// The shell: the sidebar, the banner, the grid, the status bar, the panel, and
// the keys and menus that drive them.
//
// It decides when things happen. What they do is in Workspace, Sources and
// the host, which are testable on their own.
//
// The grid is loaded when the first file opens.

import { Engine, messagePort } from "@uno/grid/engine";
import type { MessagePortLike, Offer, Reply, Request, SourceRef } from "@uno/grid/engine";
import { NO_ROW } from "@uno/grid/sheet";

import { covers } from "@uno/grid/library";
import type { Connection } from "@uno/grid/library";
import type { SingleRef } from "@uno/grid/store";
import { s3Location } from "@uno/grid/store/s3";

import { m } from "../../paraglide/messages.js";
import { columnLabel } from "../grid/rows.ts";
import type { ShellAction } from "../grid/rows.ts";
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
import { baseName, dispatch, found, message, must, settled } from "./util.ts";
import type { Handlers } from "./util.ts";

/** The localStorage key for the input strategy. */
const INPUT_KEY = "uno.input";

/**
 * The localStorage key for whether the sidebar is closed. Open is the default.
 */
const SIDEBAR_KEY = "uno.sidebar";
const SIDEBAR_CLOSED = "closed";

/** The class on #app while the sidebar is closed. */
const NO_SIDEBAR = "no-sidebar";

/**
 * An action that would close the workspace and drop its edits: Ctrl+O, the
 * window's ×, or a workspace picked from the sidebar.
 */
type Dropping = "open" | "quit" | `recent:${string}`;

export class Shell {
  /** Called with the input strategy's name whenever it changes. */
  onInput: (name: InputName) => void = () => undefined;

  private workspace: Workspace | undefined;
  /** The grid, loaded on the first open. */
  private grid: Grid | undefined;
  private gridLoading: Promise<Grid> | undefined;
  /**
   * Counts opens, so the latest wins over an earlier one that finishes later.
   */
  private opens = 0;
  /** The sources still opening, listed in the sidebar and the panel. */
  private arriving: readonly Arriving[] = [];
  /** The key of the offer dismissed with Not now. */
  private dismissed = "";
  /** What the warning on screen is about: the tab whose × would remove it, or
   * the action that would drop unsaved edits. */
  private warned: Tab | Dropping | undefined;
  /** The save in flight. A second Ctrl+S joins it, and the × waits for it. */
  private saving: Promise<void> | undefined;
  /** The input strategy, used by the grid and the status bar. */
  private input: InputStrategy = strategy(localStorage.getItem(INPUT_KEY));
  /** The open pop-up menu and formula form, if any. */
  private menu: PopMenu | undefined;
  private formula: FormulaForm | undefined;
  /** Whether the sidebar is open. */
  private sidebarOpen = localStorage.getItem(SIDEBAR_KEY) !== SIDEBAR_CLOSED;
  /** The workspaces the sidebar lists. */
  private readonly recents = new Recents(localStorage);
  /**
   * An engine for the panel until a workspace is open. Started on first use
   * and closed when a workspace brings its own.
   */
  private spare: Promise<Engine> | undefined;
  /** The last connections-read error, so it is said once. */
  private connectionTrouble = "";
  /** The connections the engine last read. */
  private known: readonly Connection[] = [];

  private readonly status: StatusBar;
  private readonly finder: Finder;
  private readonly sources: Sources;
  private readonly panel: Panel;
  /** The page's theme. */
  readonly theming: Theming;
  /** The app's language. */
  readonly language: Language;

  private readonly root = must(document.querySelector<HTMLElement>("#app"));
  private readonly workspaces = must(document.querySelector<HTMLElement>("#workspaces"));
  private readonly banner = must(document.querySelector<HTMLElement>("#banner"));
  private readonly empty = must(document.querySelector<HTMLElement>("#empty"));
  private readonly content = must(document.querySelector<HTMLElement>("#content"));

  constructor(private readonly host: Host) {
    // Language first, so everything written after is in the chosen language.
    this.language = new Language(localStorage, navigator.languages, offered(import.meta.env.DEV));
    this.language.onChange(() => this.relabel());
    // The page's static text.
    labelPage();

    // Theme next, so the page is themed before anything is drawn.
    this.theming = new Theming(
      localStorage,
      window.matchMedia("(prefers-color-scheme: dark)"),
      document.documentElement,
    );

    this.status = new StatusBar(
      (lead, typed) => {
        if (lead === ":") dispatch(this.commands, command(typed));
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
        // Listing and peeking go through an engine, which holds the listers
        // and the credentials.
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
        signIns: async () => (await this.browser()).signIns(),
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
        // A single dropped .uno opens with an empty save path, so the first
        // save asks where to write.
        if (refs.length === 1 && isWorkspace(refs[0]!)) void this.load(refs[0]!, "");
        else void this.addSources(refs);
      },
      (text) => this.say(text, true),
    );
    // Settings wires itself to the control and runs on its own from there.
    new Settings(found<HTMLButtonElement>("#settings"), this.theming, this.language, {
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
    found("#new").addEventListener("click", () => void this.open());
    found("#close").addEventListener("click", () => this.quit());
    this.wireKeys();
    // When the window regains focus, ask the buckets for newer versions and
    // the folders for new files.
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
   * askNewer asks each remote source's bucket whether it holds a newer
   * version, and repaints if anything changed.
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
   * browser returns the engine the panel uses: the open workspace's, or the
   * spare one until a workspace opens.
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

  /** closeSpare stops the spare engine. */
  private closeSpare(): void {
    const spare = this.spare;
    this.spare = undefined;
    void spare?.then((engine) => engine.close()).catch(() => undefined);
  }

  /**
   * refreshConnections reads the connections from the engine again and lists
   * them in the panel. A file that failed to read is said once.
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
   * saveConnection saves a connection and reads the connections again. Tabs
   * waiting for this bucket are then read.
   */
  async saveConnection(c: Connection): Promise<Connection> {
    const saved = await this.host.saveConnection(c);
    await this.refreshConnections();
    // Read the tabs that were waiting for this connection.
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

  /** The open tab with this id. */
  private tabAt(id: string): Tab | undefined {
    return this.workspace?.sources.find((t) => t.id === id);
  }

  /**
   * The open workspace and the grid showing it, or undefined before a file
   * opens.
   */
  private showing(): Showing | undefined {
    const workspace = this.workspace;
    const grid = this.grid;
    return workspace === undefined || grid === undefined ? undefined : { workspace, grid };
  }

  // --------------------------------------------------------------- opening

  /**
   * drops returns whether `what` may go ahead. Over unsaved edits the first
   * try warns and returns false. The second, while the warning is still on
   * screen, returns true.
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
   * open asks for a file and opens it in place of the open workspace: Ctrl+O
   * and the + at the foot of the sidebar. `force` skips the unsaved-edits
   * check, for :e and :e!.
   */
  async open(force = false): Promise<void> {
    if (!force && !this.drops("open")) return;
    try {
      const ref = await this.host.open();
      if (ref === undefined) return; // cancelled
      await this.load(ref, "path" in ref ? ref.path : "");
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /**
   * openPath opens a file by path: from the command line or the file manager.
   */
  async openPath(path: string): Promise<void> {
    await this.load(refAt(path), path);
  }

  /**
   * openRecent opens a workspace from the sidebar. Returns whether it is open
   * afterwards. One that fails to open stays listed.
   */
  private async openRecent(path: string): Promise<boolean> {
    if (this.workspace?.path === path) return true;
    if (!this.drops(`recent:${path}`)) return false;
    await this.load(refAt(path), path);
    return this.workspace?.path === path;
  }

  /** Whether the open workspace has unsaved edits. */
  get unsaved(): boolean {
    return this.workspace?.dirty === true;
  }

  /**
   * quit closes the window, after any save in flight. Over unsaved edits the
   * first × warns.
   */
  quit(): void {
    if (this.saving !== undefined) {
      void this.saving.then(() => this.quit());
      return;
    }
    if (this.drops("quit")) this.host.quit();
  }

  /** addPaths adds files by path as sources: from the command line. */
  async addPaths(paths: string[]): Promise<void> {
    await this.addSources(paths.map(refAt));
  }

  /**
   * add asks for files and adds them as sources, or opens them as a new
   * workspace.
   */
  async add(): Promise<void> {
    try {
      const refs = await this.host.add();
      if (refs.length > 0) await this.addSources(refs);
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /** offer opens a pop-up menu, closing any menu or form already open. */
  private offer(place: MenuPlace, items: readonly MenuItem[]): void {
    this.menu?.close();
    this.formula?.close();
    this.menu = new PopMenu(place, items, () => {
      this.menu = undefined;
      this.grid?.focus();
    });
  }

  /**
   * offerAdd opens the + menu: a file from this machine, or the sources panel.
   */
  private offerAdd(plus: HTMLElement): void {
    this.offer(below(plus), [
      { label: m.menu_file(), keys: "Ctrl+Shift+O", choose: () => void this.add() },
      { label: m.menu_browse_sources(), keys: "Ctrl+Shift+B", choose: () => this.showPanel() },
    ]);
  }

  /**
   * offerWorkspace opens the right-click menu on a workspace. `path` is "" for
   * an open workspace that is still unsaved.
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
   * insertFormula opens the formula form at `place` on the active source of
   * the workspace at `path`, opening that workspace first if needed.
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
   * bind computes a column from an expression, switching to transform first.
   * What the engine refuses is thrown for the form to show.
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
    // Select the column, which also scrolls it into view.
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
   * addSources adds files as sources and shows the last. The first file opens
   * a workspace when the shell lacks one. A .uno is refused by name. Returns
   * whether every one opened.
   */
  private async addSources(refs: SourceRef[]): Promise<boolean> {
    const uno = refs.find(isWorkspace);
    if (uno !== undefined) {
      this.say(m.workspace_not_a_source({ name: uno.name }), true);
      return false;
    }

    // Each is listed as opening until it has opened or been refused.
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
      // Clear any still listed, as when another open replaced the workspace.
      while (coming.length > 0) settled();
    }
  }

  /**
   * addEach opens the files one after another, calling `settled` after each.
   * Returns whether every one opened.
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
   * load starts an engine for the file and shows it. A file that fails to
   * open leaves the open workspace alone, and its engine is closed.
   */
  private async load(ref: SourceRef, savePath: string): Promise<void> {
    const open = ++this.opens;
    let engine: Engine | undefined;

    try {
      // Load the grid first, so a grid that fails leaves the engine unstarted.
      const grid = await this.loadGrid();
      engine = this.engineOn(await this.host.connect());
      let opened: Workspace | undefined;

      const w = await Workspace.open(
        ref,
        engine,
        savePath,
        () => this.repaint(),
        (tab) => {
          // Repaint the banner only for the active tab's offer.
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
      // Close any menu or form open for the replaced workspace.
      this.menu?.close();
      this.formula?.close();
      if (w.path !== "") this.recents.opened(w.path);
      // The workspace's engine serves the panel from here on.
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

  /**
   * loadGrid imports the grid and its stylesheet the first time a file opens.
   */
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
      onAction: (action) => dispatch(this.actions, action),
    };
  }

  /** The handlers for the actions the grid's keys ask of the shell. */
  private readonly actions: Handlers<ShellAction> = {
    undo: () => void this.history("undo"),
    redo: () => void this.history("redo"),
    apply: () => {
      // The offer names its own column, so this works from any cell.
      const offer = this.offered();
      if (offer === null) this.say(m.nothing_to_apply(), true);
      else void this.apply(offer);
    },
    dismiss: () => {
      const offer = this.offered();
      if (offer !== null) this.dismiss(offer);
    },
    prompt: (a) => this.status.prompt(a.lead),
    unparsed: (a) => this.finder.unparsed(a.dir),
    next: (a) => this.finder.next(a.reverse),
    tab: (a) => {
      const w = this.workspace;
      if (w === undefined) return;
      // 3gt is the third tab, as in vim. A count past the last keeps the tab.
      const to =
        a.step === 1 && a.count !== undefined
          ? w.sources[a.count - 1]
          : w.beside(a.step * (a.count ?? 1));
      if (to !== undefined) this.select(to);
    },
  };

  // ----------------------------------------------------------------- modes

  private wireKeys(): void {
    // Shortcuts are read here in place of menu accelerators, so the key
    // reaches the page. The cell editor stops its own keys.
    window.addEventListener("keydown", (e) => {
      // A key the grid already handled stops here.
      if (e.defaultPrevented) return;
      // Ctrl+PageDown, Ctrl+PageUp, Ctrl+Tab and Ctrl+Shift+Tab move between
      // tabs.
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
      const chord = this.chords.get(`${e.shiftKey ? "Shift+" : ""}${e.key.toLowerCase()}`);
      if (chord === undefined || chord.when?.() === false) return;
      e.preventDefault();
      chord.run();
    });
  }

  /**
   * The shell's Ctrl or Cmd shortcuts. `when` says whether the shortcut
   * applies; Ctrl+Z over a read-only workspace is left to the page.
   */
  private readonly chords: ReadonlyMap<string, { run: () => void; when?: () => boolean }> = new Map(
    [
      ["Shift+b", { run: () => this.showPanel() }],
      ["b", { run: () => this.toggleSidebar() }],
      ["e", { run: () => this.toggleMode() }],
      [
        "z",
        { run: () => void this.history("undo"), when: () => this.workspace?.editable === true },
      ],
    ],
  );

  /** toggleMode switches between view and transform. */
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
   * toggleSidebar opens or closes the sidebar: Ctrl+B and the switch at the
   * left of the status bar. The choice is kept for the next launch.
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

  /** togglePanel opens or closes the sources panel. */
  togglePanel(): void {
    this.panel.toggle();
    // Read the connections and the folders again when the panel opens.
    if (this.panel.open) this.refreshPanel();
    this.paintTabs();
    this.paintStatus();
    this.grid?.repaint();
  }

  /**
   * showPanel opens the sources panel and focuses it. If it is already open,
   * it only takes focus.
   */
  showPanel(): void {
    if (this.panel.open) {
      this.panel.show();
      this.refreshPanel();
      return;
    }
    this.togglePanel();
  }

  /**
   * refreshPanel reads the connections and the folders of multi-file tabs
   * again.
   */
  private refreshPanel(): void {
    void this.refreshConnections();
    void this.sources.askGrown();
  }

  /**
   * select shows another source. The selection is saved on the tab it leaves
   * and restored on the one it shows.
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

  /** showActive shows the workspace's active tab at its saved selection. */
  private showActive(): void {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;
    grid.show(w.rows, w.editable);
    grid.moveTo(w.active.cell.row, w.active.cell.col);
    this.paintAll();
  }

  /**
   * remove takes a source out of the workspace. One with edits is removed on
   * the second ×.
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
      // The workspace says whether the removed tab was showing.
      const showing = await w.remove(tab);
      if (this.workspace !== w) return;
      this.say(m.removed_name({ name: tab.name }));
      // Removing the showing tab shows its neighbour.
      this.shown(showing);
    } catch (err) {
      this.say(message(err), true);
    }
  }

  /**
   * repoint is a tab's ! mark: opens the panel to connect its bucket, to
   * reload a newer version, or to pick another file for it.
   */
  private repoint(tab: Tab): void {
    if (!this.panel.open) this.togglePanel();
    // A tab in a bucket still waiting for a connection opens the connect form.
    if (tab.link?.connect !== undefined) this.panel.connectFor(tab.id);
    // A tab with a newer version in its bucket opens on its own line, where
    // Reload is offered.
    else if (tab.newer !== undefined && !tab.missing) this.panel.showTab(tab.id);
    else this.panel.repoint(tab.id);
  }

  /**
   * reload points a tab at its own path again. The edits replay over the file
   * as it is now. An object is read as its bucket holds it now, with no
   * version pinned.
   */
  private async reload(tab: Tab): Promise<void> {
    const path = tab.link?.path;
    if (path === undefined) return;
    await this.pointAt(tab, refAt(path), (fresh) => reloaded(tab, fresh));
  }

  /**
   * pointAt points a tab at a file. The edits replay over the file. A file
   * that fails to take them is refused and the tab is left as it was.
   */
  private async pointAt(tab: Tab, ref: SourceRef, said?: (fresh: Tab) => string): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    try {
      const fresh = await w.relink(tab, ref);
      if (this.workspace !== w) return;

      // A tab still missing its file says why on its own line, so the message
      // here is empty.
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
   * append adds files to the end of a multi-file tab. Files that read
   * differently from the tab's first are refused and the tab is left as it was.
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
    // Ask the folders again: what was offered is now appended or refused.
    void this.sources.askGrown();
  }

  // ----------------------------------------------------------------- input

  /** The current input strategy's name. */
  get inputName(): InputName {
    return this.input.name;
  }

  /**
   * setInput changes the input strategy, from settings or the Edit menu, and
   * keeps the choice for the next launch.
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
    // The engine refuses a cell that is read-only, such as a bound column,
    // with a message.
    void this.editing((w) => w.set(row, col, value));
  }

  private apply(offer: Offer): Promise<void> {
    return this.editing((w) => w.apply(offer));
  }

  /**
   * editing makes one change to the workspace's log, reports an error if
   * refused, and repaints either way.
   */
  private async editing(change: (w: Workspace) => Promise<unknown>): Promise<void> {
    const w = this.workspace;
    if (w === undefined) return;
    try {
      await change(w);
      this.say("");
    } catch (err) {
      this.say(message(err), true);
    }
    this.changed(w);
  }

  /** dismiss is Not now: hides the offer until it changes. */
  private dismiss(offer: Offer): void {
    this.dismissed = offerKey(offer);
    this.paintBanner();
  }

  /** history undoes the last edit, or redoes the last undone one. */
  private history(which: "undo" | "redo"): Promise<void> {
    return this.editing(async (w) => {
      // The edit is on the active tab. If the tab changes before it lands, the
      // selection stays.
      const tab = w.active;
      const edit = await (which === "undo" ? w.undo() : w.redo());
      // Move to the changed cell. An apply names a column alone, so the
      // selection stays.
      const on = this.showing();
      if (edit.row !== NO_ROW && on?.workspace === w && w.active === tab) {
        on.grid.moveTo(edit.row, edit.col);
      }
    });
  }

  /**
   * After an edit: refresh the grid, since kinds may have changed, and repaint.
   */
  private changed(w: Workspace): void {
    const on = this.showing();
    if (on?.workspace !== w) return;
    on.grid.refresh();
    this.paintAll();
  }

  // ---------------------------------------------------------------- saving

  /**
   * save writes the workspace to its path, asking for one the first time. One
   * save at a time: a second joins the one in flight.
   */
  save(): Promise<void> {
    return this.saveTo((w) => (w.path === "" ? undefined : w.path));
  }

  /**
   * saveAs asks where to save, then writes. The bytes depend on the path,
   * because sources beside the workspace are referenced relative to it.
   */
  saveAs(): Promise<void> {
    return this.saveTo(() => undefined);
  }

  /** saveTo runs one save at a time, to the path `where` picks. */
  private saveTo(where: (w: Workspace) => string | undefined): Promise<void> {
    if (this.saving !== undefined) return this.saving;
    const on = this.showing();
    if (on === undefined) return Promise.resolve();
    this.saving = this.write(on, where(on.workspace));
    return this.saving;
  }

  /**
   * write is the save: the dialog when `path` is undefined, then the bytes
   * to the host. Saving over a file a source reads from is refused.
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

  /** The handlers for commands typed at the prompt. */
  private readonly commands: Handlers<Command> = {
    none: () => {},
    write: () => void this.save(),
    "save-as": () => void this.saveAs(),
    open: (c) => {
      // :e over unsaved edits asks for :e! first.
      if (!c.force && this.workspace?.dirty === true) this.say(m.unsaved_edits_command(), true);
      else void this.open(true);
    },
    sources: () => this.showPanel(),
    row: (c) => this.grid?.act({ t: "move", motion: "last-row", count: c.row }),
    unknown: (c) => this.say(m.not_a_command({ text: c.text }), true),
  };

  // -------------------------------------------------------------- painting

  /**
   * Rows landed or the index moved: repaint the grid body and the status bar.
   */
  private repaint(): void {
    this.grid?.repaint();
    this.paintStatus();
  }

  /**
   * relabel rewrites the window in the current language, leaving everything
   * open.
   */
  private relabel(): void {
    labelPage();
    // An open menu or form was built in the old language.
    this.menu?.close();
    this.formula?.close();
    // So was the last message.
    this.say("");
    this.panel.relabel();
    // The header's hints, which the grid draws once per file.
    this.grid?.refresh();
    this.paintAll();
  }

  /**
   * withTab runs `act` on the tab with this id, if the workspace still has it.
   */
  private withTab(id: string, act: (tab: Tab) => void): void {
    const tab = this.tabAt(id);
    if (tab !== undefined) act(tab);
  }

  /**
   * engineOn creates an engine over a port and shows its unasked errors in the
   * status bar.
   */
  private engineOn(port: MessagePortLike): Engine {
    const engine = new Engine(messagePort<Reply, Request>(port));
    engine.onError = (heard) => this.say(say(heard), true);
    return engine;
  }

  /**
   * shown repaints after a tab changed: the grid if it is the showing tab,
   * the sidebar otherwise, and the status bar either way.
   */
  private shown(showing: boolean): void {
    if (showing) this.showActive();
    else this.paintTabs();
    this.paintStatus();
  }

  /** paintAll draws the sidebar, the banner and the status bar. */
  private paintAll(): void {
    this.paintTabs();
    this.paintBanner();
    this.paintStatus();
  }

  /** paintTabs draws the sidebar and redraws the panel. */
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
    // The panel lists the tabs too.
    this.panel.draw();
  }

  /**
   * The offer the banner shows, or null when there is none or it was dismissed.
   */
  private offered(): Offer | null {
    const offer = this.workspace?.offer ?? null;
    return offer === null || this.dismissed === offerKey(offer) ? null : offer;
  }

  /** paintBanner draws the banner for the current offer, or hides it. */
  private paintBanner(): void {
    const offer = this.offered();
    if (offer === null) {
      this.banner.hidden = true;
      this.banner.replaceChildren();
      return;
    }

    // Both give focus back to the grid.
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

  /**
   * say writes the status bar's message line. A message stays until the next
   * one.
   */
  private say(text: string, isError = false): void {
    // Any message replaces the unsaved-edits warning, so a second Ctrl+O
    // works only while the warning is on screen.
    this.warned = undefined;
    this.status.say(text, isError);
  }
}

/** isWorkspace returns whether a ref is a .uno file. */
function isWorkspace(ref: SourceRef): boolean {
  // Several files read as one are a source, whatever they are called.
  return !("parts" in ref) && ref.name.toLowerCase().endsWith(".uno");
}

/** refAt makes a SourceRef for a path. */
function refAt(path: string): SourceRef {
  return { name: baseName(path), path };
}
