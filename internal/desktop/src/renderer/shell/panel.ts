// The sources panel: the column beside the grid, with its head, a filter box,
// the three sections of `Sources` drawn as one virtualised list, a peek at
// the picked file, and the buttons that add what is picked.
//
// The list reuses a pool of row elements, as the grid does, and writes text
// into them as it scrolls. `Sources` owns what each line says and which line
// has focus. This file draws it and reads keys.

import "./arriving.css";
import "./panel.css";

import type { Peeked, SourceRef } from "@uno/grid/engine";
import type { SingleRef } from "@uno/grid/store";

import { m } from "../../paraglide/messages.js";
import { firstRow, fitPool, poolSize } from "../grid/metrics.ts";
import type { InputName } from "../input/index.ts";
import { bytes } from "../locale.ts";
import { say } from "../said.ts";
import {
  SECTIONS,
  connecting,
  connectionLine,
  failed,
  fileCount,
  newFiles,
  opening,
  stateOf,
  stateWord,
} from "../sources.ts";
import type {
  Arriving,
  Button,
  Connection,
  Doing,
  Joining,
  Place,
  Section,
  Sources,
  TabAction,
} from "../sources.ts";
import { ConnectForm } from "./connect.ts";
import type { ConnectAsks, Filled } from "./connect.ts";
import { Words, el } from "./util.ts";

/**
 * One row's height in pixels. It is set on the root as `--panel-row-h`, so
 * the stylesheet and the virtualiser use the same value.
 */
const ROW_H = 24;

/** The key for each tab action. */
const DOING_KEYS: ReadonlyMap<string, Doing> = new Map([
  ["r", "reload"],
  ["c", "connect"],
  ["p", "repoint"],
  ["a", "append"],
  ["Delete", "remove"],
]);

/** The heading for each section. */
const TITLES: Record<Section, () => string> = {
  workspace: m.section_workspace,
  connections: m.section_connections,
  browser: m.section_browser,
};

/** Shown in place of an unknown size. */
const NO_SIZE = "—";

/** What the panel asks of the shell. */
export interface PanelActions {
  /** Show the tab with this id. */
  select(id: string): void;
  /**
   * Add sources to the workspace, one tab each. Returns whether every one
   * opened.
   */
  add(refs: readonly SourceRef[]): Promise<boolean>;
  /** Append files to the tab with this id, which reads several files as one. */
  append(id: string, files: readonly SingleRef[]): void;
  /** Reload the tab with this id from its file. */
  reload(id: string): void;
  /** Point the tab with this id at another file. */
  repoint(id: string, ref: SourceRef): void;
  /** Take the tab with this id out of the workspace. */
  remove(id: string): void;
  /** Called when the panel closes. */
  closed(): void;
}

/** Where a section's rows start in the column, and how many lines it has. */
export interface Span {
  section: Section;
  start: number;
  lines: number;
}

/** A row of the column: a section's heading, one of its lines, or a note
 * when it is empty. */
export type Row =
  | { t: "head"; section: Section }
  | { t: "line"; section: Section; line: number }
  | { t: "note"; section: Section };

/**
 * spans lays the sections out as one column: a heading, then its lines, or
 * one note row when there are none.
 */
export function spans(count: (section: Section) => number): Span[] {
  let start = 0;
  return SECTIONS.map((section) => {
    const lines = count(section);
    const span = { section, start, lines };
    start += 1 + Math.max(lines, 1);
    return span;
  });
}

/** rowCount returns the number of rows in the column. */
export function rowCount(laid: readonly Span[]): number {
  const last = laid[laid.length - 1];
  return last === undefined ? 0 : last.start + 1 + Math.max(last.lines, 1);
}

/** rowAt returns the row at `index`. */
export function rowAt(laid: readonly Span[], index: number): Row {
  let span = laid[0]!;
  for (const s of laid) if (s.start <= index) span = s;
  const at = index - span.start;
  if (at === 0) return { t: "head", section: span.section };
  if (span.lines === 0) return { t: "note", section: span.section };
  return { t: "line", section: span.section, line: at - 1 };
}

/** rowOf returns the row index of a line. */
export function rowOf(laid: readonly Span[], place: Place): number {
  const span = laid.find((s) => s.section === place.section)!;
  return span.start + 1 + place.line;
}

export class Panel {
  private readonly input = el("input");
  private readonly list = el("div", "panel-list");
  private readonly sizer = el("div", "panel-sizer");
  private readonly rows = el("div", "panel-rows");
  /** The first rows of the picked file, under the list. */
  private readonly peek = el("div", "panel-peek");
  /** The buttons that add what is picked. */
  private readonly foot = el("div", "panel-foot");
  /**
   * What the peek and the foot were last drawn from, so they are redrawn
   * only when it changes.
   */
  private drawnPeek: Peeked | "reading" | undefined;
  private drawnFoot = "";
  /** Text the panel writes once: its head and its filter. */
  private readonly words = new Words();
  /** One element per row on screen, reused as the list scrolls. */
  private pool: HTMLElement[] = [];
  private laid: Span[] = [];
  private frame = 0;
  /** The filter form, hidden with the list while the connect form is open. */
  private readonly filter = el("form", "panel-filter");
  /** The connect form, which takes the list's place while open. */
  private readonly connecting: ConnectForm;

  constructor(
    private readonly root: HTMLElement,
    private readonly sources: Sources,
    /** The current input strategy. j and k move only under vim-style. */
    private readonly keys: () => InputName,
    private readonly act: PanelActions,
    asks: ConnectAsks,
  ) {
    root.style.setProperty("--panel-row-h", `${ROW_H}px`);

    const form = this.filter;
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    // The placeholder says that an S3 address typed here is added.
    this.words.placeholder(this.input, m.panel_filter_placeholder);
    this.words.attr(this.input, "aria-label", m.panel_filter_aria);
    const go = this.words.text(el("button"), m.action_filter);
    go.type = "submit";
    form.append(this.input, go);
    // Enter in the box and the button both submit.
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.search();
    });
    this.input.addEventListener("keydown", (e) => {
      // Keep the key from reaching the grid and the shell's shortcuts.
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        this.list.focus();
      }
    });

    this.list.tabIndex = 0;
    this.sizer.append(this.rows);
    this.list.append(this.sizer);
    this.list.addEventListener("scroll", () => this.draw(), { passive: true });
    this.list.addEventListener("keydown", (e) => this.key(e));
    this.list.addEventListener("click", (e) => this.click(e));

    this.peek.hidden = true;
    this.foot.hidden = true;

    // A saved connection is browsed at once.
    this.connecting = new ConnectForm(
      asks,
      (saved) => {
        this.sources.connect(undefined);
        this.showList();
        if (saved !== undefined)
          void this.sources.open(connectionLine(saved)).then(() => this.reveal());
      },
      {
        // Show the list again while the connection is tested and saved, with
        // focus on the line that says so.
        keeping: (draft) => {
          this.sources.connect({ name: draft.name });
          this.sources.focus("connections", this.sources.connections.length);
          this.listIn();
          this.reveal();
        },
        // The line stays, marked failed. Choosing it edits the connection.
        refused: (draft, why) => {
          this.sources.connect({ name: draft.name, failed: why });
          this.layout();
        },
      },
    );

    // The head begins under the window's top line, which index.html keeps for
    // the × that closes the window.
    const head = this.words.text(el("div", "panel-head col-head"), m.sources_title);

    root.append(head, form, this.list, this.peek, this.foot, this.connecting.el);
  }

  /** connect opens the connect form in the list's place, with `filled`. */
  connect(filled: Filled = {}): void {
    if (!this.open) this.show();
    // A connection still being saved is given up.
    this.sources.connect(undefined);
    this.listOut();
    this.connecting.show(filled);
  }

  /** listOut hides the filter, the list, the peek and the foot. */
  private listOut(): void {
    this.filter.hidden = true;
    this.list.hidden = true;
    this.peek.hidden = true;
    this.foot.hidden = true;
  }

  /**
   * browse lists a connection from its start. The connect form, if open, is
   * hidden.
   */
  browse(c: Connection): void {
    if (this.connecting.open) this.showList();
    void this.sources.open(c).then(() => this.reveal());
  }

  /** showList hides the connect form and shows the list. */
  private showList(): void {
    this.connecting.hide();
    this.listIn();
  }

  /** listIn shows the filter and the list, redraws, and focuses the list. */
  private listIn(): void {
    this.filter.hidden = false;
    this.list.hidden = false;
    this.drawnPeek = undefined;
    this.drawnFoot = "";
    this.layout();
    this.list.focus();
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /**
   * relabel rewrites the panel's text in the current language, including the
   * connect form, the peek and the foot.
   */
  relabel(): void {
    this.words.write();
    this.connecting.relabel();
    this.drawnPeek = undefined;
    this.drawnFoot = "";
    this.draw();
  }

  /**
   * show opens the panel and focuses the list, or leaves focus in the connect
   * form if open.
   */
  show(): void {
    this.root.hidden = false;
    if (this.connecting.open) return;
    this.layout();
    this.list.focus();
  }

  hide(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.act.closed();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  /**
   * repoint opens the panel browsing the folder of the tab's file, to pick a
   * new file for it.
   */
  repoint(id: string): void {
    const tab = this.sources.tabs.find((t) => t.id === id);
    if (tab === undefined) return;
    if (!this.open) this.show();
    void this.sources.repoint(tab).then(() => this.reveal());
  }

  /**
   * showTab opens the panel with focus on a tab's line, where its actions are
   * offered.
   */
  showTab(id: string): void {
    const line = this.sources.tabs.findIndex((t) => t.id === id);
    if (line < 0) return;
    if (!this.open) this.show();
    this.sources.focus("workspace", line);
    this.layout();
    this.reveal();
    this.list.focus();
  }

  /** draw schedules a layout on the next frame, at most once. */
  draw(): void {
    if (this.frame !== 0 || this.root.hidden) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  }

  /**
   * search filters every section by the box's text and focuses the list. An
   * S3 object address is added instead, and the box is emptied.
   */
  private search(): void {
    this.sources.search(this.input.value);
    const pasted = this.sources.pasted;
    if (pasted !== undefined) {
      this.input.value = "";
      this.give(pasted);
    }
    this.list.scrollTop = 0;
    this.layout();
    this.reveal();
    this.list.focus();
  }

  /**
   * key handles a key on the list. The arrows move for everyone; j and k only
   * under vim-style. Any other key goes on to the shell.
   */
  private key(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const page = Math.max(1, Math.floor(this.list.clientHeight / ROW_H) - 1);
    // The movement keys and their steps.
    const steps = new Map([
      ["ArrowDown", 1],
      ["ArrowUp", -1],
      ["PageDown", page],
      ["PageUp", -page],
    ]);
    if (this.keys() === "vim-style") steps.set("j", 1).set("k", -1);

    switch (e.key) {
      case "Enter":
        this.choose();
        break;
      case " ":
        this.pick();
        break;
      case "Backspace":
        void this.sources.up();
        break;
      case "/":
        this.input.focus();
        this.input.select();
        break;
      case "Escape":
        // Esc stops picking a file for a tab before it closes the panel.
        if (this.sources.repointing !== undefined) this.sources.stop();
        else this.hide();
        break;
      default: {
        const step = steps.get(e.key);
        if (step !== undefined) {
          this.move(step);
          break;
        }
        // A tab action key, when focus is on a tab's line. Otherwise the key
        // goes on to the shell.
        const does = DOING_KEYS.get(e.key);
        const action = this.sources.doings.find((a) => a.does === does);
        if (does === undefined || action === undefined) return;
        this.doing(action);
      }
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private move(step: number): void {
    this.sources.move(step);
    this.layout();
    this.reveal();
  }

  /** click focuses a line and chooses it, as Enter would. */
  private click(e: MouseEvent): void {
    const hit = (e.target as HTMLElement).closest<HTMLElement>(".panel-row");
    const index = Number(hit?.dataset["row"]);
    if (!Number.isInteger(index)) return;
    const row = rowAt(this.laid, index);
    if (row.t !== "line") return;
    // A line still arriving ignores the click. Choosing a refused connection
    // edits it.
    const coming = this.arriving(row.section, row.line);
    if (coming !== undefined && coming.failed === undefined) return;
    this.sources.focus(row.section, row.line);
    this.layout();
    this.choose();
  }

  /** pick is Space: toggles a browser file in or out of the selection. */
  private pick(): void {
    const { section, line } = this.sources.place;
    const entry = section === "browser" ? this.sources.entries[line] : undefined;
    if (entry !== undefined) void this.sources.toggle(entry);
  }

  /**
   * choose is Enter on the focused line: a tab is shown, a connection is
   * browsed, a folder is entered. On a file it adds the selection one tab
   * each, or the file itself when the selection is empty.
   */
  private choose(): void {
    const { section, line } = this.sources.place;
    switch (section) {
      case "workspace": {
        const tab = this.sources.tabs[line];
        if (tab !== undefined) this.act.select(tab.id);
        return;
      }
      case "connections": {
        if (this.sources.isConnect(line)) return this.connect();
        if (this.failure() !== undefined) return this.edit();
        const to = this.sources.connections[line];
        if (to !== undefined) void this.sources.open(to);
        return;
      }
      case "browser": {
        const entry = this.sources.entries[line];
        if (entry === undefined) return;
        if (entry.folder) void this.sources.enter(entry);
        else if (this.sources.selected.length > 0) this.press(this.sources.buttons[0]!);
        else if (this.sources.selectable(entry)) this.give({ name: entry.name, path: entry.path });
      }
    }
  }

  /**
   * arriving returns what a line stands for that is still on its way, if
   * anything: a source opening, on the workspace lines after the tabs, or the
   * connection being saved, on the line after the connections.
   */
  private arriving(section: Section, line: number): Arriving | undefined {
    switch (section) {
      case "workspace":
        return this.sources.opening[line - this.sources.tabs.length];
      case "connections":
        return line === this.sources.connections.length ? this.sources.connecting : undefined;
      case "browser":
        return undefined;
    }
  }

  /** failure returns the refused connection on the focused line, if any. */
  private failure(): Arriving | undefined {
    const { section, line } = this.sources.place;
    const coming = this.arriving(section, line);
    return coming?.failed === undefined ? undefined : coming;
  }

  /** edit reopens the connect form as it was left when its save was refused. */
  private edit(): void {
    this.listOut();
    this.connecting.reopen();
  }

  /** reveal scrolls as little as needed to bring the focused line into view. */
  private reveal(): void {
    const top = rowOf(this.laid, this.sources.place) * ROW_H;
    const viewport = this.list.clientHeight;
    if (top < this.list.scrollTop) this.list.scrollTop = top;
    else if (top + ROW_H > this.list.scrollTop + viewport) {
      this.list.scrollTop = top + ROW_H - viewport;
    }
    this.layout();
  }

  /**
   * layout is the virtualiser: it sizes the sizer to the whole column, moves
   * the pool to the first visible row, and paints each pooled element.
   */
  private layout(): void {
    // Drawing waits while the connect form has the list's place.
    if (this.connecting.open) return;
    this.laid = spans((s) => this.sources.count(s));
    const total = rowCount(this.laid);
    this.sizer.style.height = `${total * ROW_H}px`;

    const want = poolSize(total, this.list.clientHeight, ROW_H);
    fitPool(this.pool, want, () => line(), this.rows);

    const first = firstRow(total, this.pool.length, this.list.scrollTop, ROW_H);
    this.rows.style.transform = `translateY(${first * ROW_H}px)`;
    const at = this.sources.place;
    for (let i = 0; i < this.pool.length; i++) this.paint(this.pool[i]!, first + i, at);

    // Ask for the next page when the end of the folder scrolls into view.
    // `next` loads one page at a time.
    if (this.sources.more && first + this.pool.length >= total) void this.sources.next();

    this.paintPeek();
    this.paintFoot();
  }

  /**
   * press hands a button's files to the shell: to add, or to point a tab at.
   */
  private press(b: Button): void {
    if (b.to === undefined) return this.add(b.refs);
    this.sources.stop();
    this.act.repoint(b.to, b.refs[0]!);
  }

  /**
   * give handles one file chosen by Enter or by address:
   * it points the tab being repointed at it, or adds it.
   */
  private give(ref: SourceRef): void {
    const to = this.sources.repointing;
    if (to === undefined) return this.add([ref]);
    this.sources.stop();
    this.act.repoint(to.id, ref);
  }

  /**
   * add hands sources to the shell to open and unpicks them once every one
   * has opened. When any fails to open, they all stay picked.
   */
  private add(refs: readonly SourceRef[]): void {
    void this.act.add(refs).then((opened) => {
      if (opened) this.sources.added(refs);
    });
  }

  /** doing runs a tab action, from its button or its key. */
  private doing(a: TabAction): void {
    this.doings[a.does](a);
  }

  private readonly doings: Record<Doing, (a: TabAction) => void> = {
    reload: (a) => this.act.reload(a.id),
    remove: (a) => this.act.remove(a.id),
    repoint: (a) => this.repoint(a.id),
    connect: (a) => this.connectFor(a.id),
    append: (a) => this.act.append(a.id, a.files ?? []),
  };

  /**
   * connectFor opens the connect form for the bucket a tab reads, with the
   * bucket and folder filled in. The form opens while the tab is still open
   * and its bucket is waiting for a connection.
   */
  connectFor(id: string): void {
    const wants = this.sources.tabs.find((t) => t.id === id)?.link?.connect;
    if (wants !== undefined) this.connect({ bucket: wants.bucket, prefix: wants.prefix });
  }

  /** paintPeek draws the header and first rows of the picked file. */
  private paintPeek(): void {
    const s = this.sources;
    const now = s.peeking ? "reading" : s.peeked;
    if (now === this.drawnPeek) return;
    this.drawnPeek = now;
    this.peek.hidden = now === undefined;
    if (now === undefined) return this.peek.replaceChildren();
    if (now === "reading") {
      this.peek.replaceChildren(el("div", "note", m.panel_peeking()));
      return;
    }

    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const h of now.header) head.append(el("th", "", h));
    const body = table.createTBody();
    for (const row of now.rows) {
      const tr = body.insertRow();
      for (const cell of row) tr.append(el("td", "", cell));
    }
    const wrap = el("div", "table");
    wrap.append(table);
    this.peek.replaceChildren(el("div", "note", say(now.label)), wrap);
  }

  /**
   * paintFoot draws the refusal, the focused tab's actions, the join choices,
   * and the add buttons. The foot is hidden when there are none.
   */
  private paintFoot(): void {
    const doings = this.sources.doings;
    const buttons = this.sources.buttons;
    const joining = this.sources.joining;
    const failure = this.failure();
    // A key for what the foot shows. Buttons read the sources again when
    // pressed, so ticking a choice leaves the foot as drawn.
    const key = [
      ...doings.map((a) => a.does + a.id + a.label),
      ...buttons.map((b) => b.label + (b.to ?? "") + b.refs.map(placeOf).join()),
      joining === undefined ? "" : "joining",
      failure === undefined ? "" : `failed${failure.name}${failure.failed}`,
    ].join("|");
    if (key === this.drawnFoot) return;
    this.drawnFoot = key;
    this.foot.hidden = doings.length === 0 && buttons.length === 0 && failure === undefined;
    this.foot.replaceChildren(
      ...(failure === undefined ? [] : this.refusal(failure)),
      ...doings.map((a) => {
        const button = el("button", a.does === "append" ? "wide" : "", a.label);
        button.addEventListener("click", () => this.doing(a));
        return button;
      }),
      ...(joining === undefined ? [] : [this.choices(joining)]),
      ...buttons.map((b, i) => {
        const button = el("button", b.one ? "" : "primary", b.label);
        // Read the button as it stands when pressed.
        button.addEventListener("click", () => this.press(this.sources.buttons[i] ?? b));
        return button;
      }),
    );
  }

  /**
   * refusal is the foot's line for a refused connection: why, and the button
   * that edits it.
   */
  private refusal(failure: Arriving): HTMLElement[] {
    const editing = el("button", "primary", m.action_edit_connection());
    editing.addEventListener("click", () => this.edit());
    return [el("div", "why", `✗ ${failure.failed}`), editing];
  }

  /**
   * choices is the line above "Add as one": whether each file has a header
   * row, and whether a `_file` column records which file a row came from.
   */
  private choices(joining: Joining): HTMLElement {
    const line = el("div", "choices");
    line.append(
      el("span", "", m.panel_as_one()),
      choice(m.panel_header_row(), m.panel_header_row_hint(), joining.header === "first", (on) =>
        this.sources.join({ header: on ? "first" : "none" }),
      ),
      choice(m.panel_file_column(), m.panel_file_column_hint(), joining.fileColumn, (on) =>
        this.sources.join({ fileColumn: on }),
      ),
    );
    return line;
  }

  private paint(el: HTMLElement, index: number, at: Place): void {
    const row = rowAt(this.laid, index);
    el.dataset["row"] = String(index);
    let name = "";
    let meta = "";
    let title = "";
    let cls = "panel-row";

    if (row.t === "head") {
      cls += " head";
      const pointing = row.section === "browser" ? this.sources.repointing : undefined;
      name =
        pointing === undefined ? TITLES[row.section]() : m.panel_point_at({ name: pointing.name });
      if (row.section === "browser") meta = this.sources.crumb.map((c) => c.name).join(" / ");
    } else if (row.t === "note") {
      cls += " note";
      name = this.note(row.section);
    } else {
      if (row.section === at.section && row.line === at.line) cls += " sel";
      const entry = row.section === "browser" ? this.sources.entries[row.line] : undefined;
      if (entry !== undefined && !entry.folder) {
        if (this.sources.chosen(entry)) cls += " picked";
        else if (!this.sources.selectable(entry)) cls += " off";
      }
      if (row.section === "connections" && this.sources.isConnect(row.line)) cls += " action";
      const coming = this.arriving(row.section, row.line);
      if (coming !== undefined) {
        cls += coming.failed === undefined ? " opening" : " failed";
        title = coming.failed ?? "";
      }
      const tab = row.section === "workspace" ? this.sources.tabs[row.line] : undefined;
      if (tab !== undefined) {
        const state = stateOf(tab);
        if (state !== "fine") cls += ` ${state}`;
        else if (this.sources.grown(tab) !== undefined) cls += " grown";
        // The hover text: the file's path, or each part's, and what is wrong
        // with it.
        title = [
          tab.link?.path,
          ...(tab.parts ?? []).map((part) => part.path || part.name),
          tab.link?.missing === undefined
            ? tab.newer === undefined
              ? undefined
              : m.newer_version()
            : say(tab.link.missing),
          tab.link?.changed === undefined ? undefined : say(tab.link.changed),
        ]
          .filter((t) => t !== undefined)
          .join(" · ");
      }
      [name, meta] = this.line(row.section, row.line);
    }

    if (el.className !== cls) el.className = cls;
    if (el.title !== title) el.title = title;
    set(el.children[0]!, name);
    set(el.children[1]!, meta);
  }

  /** line returns one line's name and the text beside it. */
  private line(section: Section, line: number): [string, string] {
    switch (section) {
      case "workspace": {
        const t = this.sources.tabs[line];
        if (t === undefined) {
          const coming = this.arriving(section, line);
          return coming === undefined ? ["", ""] : [coming.name, opening()];
        }
        const state = stateOf(t);
        if (state !== "fine") return [t.name, stateWord(state)];
        // A tab of several files shows how many new files its folder has
        // gained, or how many files it has.
        const grown = this.sources.grown(t);
        if (grown !== undefined) return [t.name, newFiles(grown.files.length)];
        if (t.parts !== undefined) return [t.name, fileCount(t.parts.length)];
        return [t.name, t.bytes === undefined ? "" : bytes(t.bytes)];
      }
      case "connections": {
        if (this.sources.isConnect(line)) return [m.connect_action(), ""];
        const c = this.sources.connections[line];
        if (c === undefined) {
          const coming = this.arriving(section, line);
          if (coming === undefined) return ["", ""];
          return [coming.name, coming.failed === undefined ? connecting() : failed()];
        }
        return [c.name, c.where === undefined ? c.kind : `${c.kind} · ${c.where}`];
      }
      case "browser": {
        const e = this.sources.entries[line];
        if (e === undefined) return ["", ""];
        if (e.folder) return [`${e.name}/`, ""];
        return [e.name, e.bytes === undefined ? NO_SIZE : bytes(e.bytes)];
      }
    }
  }

  /** note returns the text for an empty section. */
  private note(section: Section): string {
    const s = this.sources;
    if (section === "browser") {
      if (s.reading) return m.reading();
      if (s.trouble !== "") return s.trouble;
      if (s.path === "") return m.panel_choose_connection();
    }
    if (s.filter !== "") return m.panel_nothing_matches({ filter: s.filter });
    switch (section) {
      case "workspace":
        return m.panel_no_sources();
      case "connections":
        return m.no_connections();
      case "browser":
        return m.panel_folder_empty();
    }
  }
}

/** placeOf returns a ref's path, or its parts' paths joined. */
function placeOf(ref: SourceRef): string {
  if ("parts" in ref) return ref.parts.map((part) => placeOf(part.ref)).join();
  return "path" in ref ? ref.path : ref.name;
}

/** choice creates one checkbox with a label and a hover hint. */
function choice(
  label: string,
  hint: string,
  on: boolean,
  changed: (on: boolean) => void,
): HTMLElement {
  const line = el("label");
  line.title = hint;
  const box = el("input");
  box.type = "checkbox";
  box.checked = on;
  box.addEventListener("change", () => changed(box.checked));
  // Keep the key from reaching the grid and the shell's shortcuts.
  box.addEventListener("keydown", (e) => e.stopPropagation());
  line.append(box, label);
  return line;
}

/** set writes text only when it changed. */
function set(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** line creates one empty row element with two spans. */
function line(): HTMLElement {
  const row = el("div");
  row.append(el("span"), el("span"));
  return row;
}
