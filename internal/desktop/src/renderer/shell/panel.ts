// The panel's column: the three sections of `Sources` drawn as one list beside
// the grid, a filter over all of them, the keys that walk it, and underneath,
// the front of the file picked and the buttons that add what is picked.
//
// The list is virtualised the way the grid is. A prefix of 200,000 objects is
// the rows on screen and a few either side, and scrolling writes text into the
// same elements rather than making more. What is on each line, and which line
// the keys are on, is `Sources`'s; this file only draws it and reads keys.

import "./panel.css";

import { formatBytes } from "@uno/grid/engine";
import type { Peeked, SourceRef } from "@uno/grid/engine";

import { firstRow, poolSize } from "../grid/metrics.ts";
import type { InputName } from "../input/index.ts";
import { SECTIONS, STATE_WORDS, connectionLine, stateOf } from "../sources.ts";
import type { Button, Connection, Doing, Place, Section, Sources, TabAction } from "../sources.ts";
import { ConnectForm } from "./connect.ts";
import type { ConnectAsks, Filled } from "./connect.ts";

/**
 * One line's height, in one place. The stylesheet is handed it as
 * `--panel-row-h` rather than declaring its own, since the virtualiser does
 * arithmetic with it and two copies would disagree the first time one changed.
 */
const ROW_H = 24;

/**
 * The key for each thing a tab's line offers. Connect is the key a tab waiting
 * for its bucket has in Reload's place, since reloading it is not on offer.
 */
const DOING_KEYS: Record<string, Doing> = {
  r: "reload",
  c: "connect",
  p: "repoint",
  Delete: "remove",
};

const TITLES: Record<Section, string> = {
  workspace: "In this workspace",
  connections: "Connections",
  browser: "Browser",
};

/** What choosing a line does. The shell decides; the panel only asks. */
export interface PanelActions {
  /** Show the tab with this id. */
  select(id: string): void;
  /** Add files to the workspace: a tab each, or `one` source between them. */
  add(refs: readonly SourceRef[], one: boolean): void;
  /** Read the tab with this id from its file again. */
  reload(id: string): void;
  /** Point the tab with this id at another file. */
  repoint(id: string, ref: SourceRef): void;
  /** Take the tab with this id out of the workspace. */
  remove(id: string): void;
  /** The panel closed, so the keys go back to the grid. */
  closed(): void;
}

/** Where a section's rows begin in the column, and how many lines it has. */
export interface Span {
  section: Section;
  start: number;
  lines: number;
}

/** A row of the column: a section's title, one of its lines, or what it says
 * when it has none. */
export type Row =
  | { t: "head"; section: Section }
  | { t: "line"; section: Section; line: number }
  | { t: "note"; section: Section };

/**
 * spans lays the sections out as one column: a title, then the lines, or one
 * note in their place when there are none, so an empty section still says why.
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

/** The number of rows the column is. */
export function rowCount(laid: readonly Span[]): number {
  const last = laid[laid.length - 1];
  return last === undefined ? 0 : last.start + 1 + Math.max(last.lines, 1);
}

/** rowAt is what the row at `index` of the column is. */
export function rowAt(laid: readonly Span[], index: number): Row {
  let span = laid[0]!;
  for (const s of laid) if (s.start <= index) span = s;
  const at = index - span.start;
  if (at === 0) return { t: "head", section: span.section };
  if (span.lines === 0) return { t: "note", section: span.section };
  return { t: "line", section: span.section, line: at - 1 };
}

/** rowOf is where a line sits in the column, for keeping the keys in view. */
export function rowOf(laid: readonly Span[], place: Place): number {
  const span = laid.find((s) => s.section === place.section)!;
  return span.start + 1 + place.line;
}

export class Panel {
  private readonly input = document.createElement("input");
  private readonly list = document.createElement("div");
  private readonly sizer = document.createElement("div");
  private readonly rows = document.createElement("div");
  /** The front of the one picked file, under the list. */
  private readonly peek = document.createElement("div");
  /** The buttons that add what is picked. */
  private readonly foot = document.createElement("div");
  /** What the peek and the buttons were last drawn from, so a scroll redraws neither. */
  private drawnPeek: Peeked | "reading" | undefined;
  private drawnFoot = "";
  /** One element per row on screen, reused as the list scrolls. */
  private pool: HTMLElement[] = [];
  private laid: Span[] = [];
  private frame = 0;
  /** The filter box's form, hidden with the list while a bucket is being connected. */
  private readonly filter = document.createElement("form");
  /** Connecting a bucket, which takes the list's place while it is open. */
  private readonly connecting: ConnectForm;

  constructor(
    private readonly root: HTMLElement,
    private readonly sources: Sources,
    /** How keys are read now, so j and k move only for someone reading them vim's way. */
    private readonly keys: () => InputName,
    private readonly act: PanelActions,
    asks: ConnectAsks,
  ) {
    root.style.setProperty("--panel-row-h", `${ROW_H}px`);

    const form = this.filter;
    form.className = "panel-filter";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    // An object's address is added rather than filtered by, so the box says so.
    this.input.placeholder = "filter, or paste s3://…";
    this.input.setAttribute("aria-label", "filter sources");
    const go = document.createElement("button");
    go.type = "submit";
    go.textContent = "Filter";
    form.append(this.input, go);
    // Enter in the box and the button are one submit, and neither leaves the page.
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.search();
    });
    this.input.addEventListener("keydown", (e) => {
      // The grid's keys and the shell's chords stay out of what is typed here.
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        this.list.focus();
      }
    });

    this.list.className = "panel-list";
    this.list.tabIndex = 0;
    this.sizer.className = "panel-sizer";
    this.rows.className = "panel-rows";
    this.sizer.append(this.rows);
    this.list.append(this.sizer);
    this.list.addEventListener("scroll", () => this.draw(), { passive: true });
    this.list.addEventListener("keydown", (e) => this.key(e));
    this.list.addEventListener("click", (e) => this.click(e));

    this.peek.className = "panel-peek";
    this.peek.hidden = true;
    this.foot.className = "panel-foot";
    this.foot.hidden = true;

    // A connection saved is browsed at once, from where it starts: saving one
    // is how a person says they want to look in it.
    this.connecting = new ConnectForm(asks, (saved) => {
      this.showList();
      if (saved !== undefined)
        void this.sources.open(connectionLine(saved)).then(() => this.reveal());
    });

    root.append(form, this.list, this.peek, this.foot, this.connecting.el);
  }

  /**
   * connect opens the form that connects a bucket, in the list's place, filled
   * in with what the caller already knows.
   */
  connect(filled: Filled = {}): void {
    if (!this.open) this.show();
    this.filter.hidden = true;
    this.list.hidden = true;
    this.peek.hidden = true;
    this.foot.hidden = true;
    this.connecting.show(filled);
  }

  /**
   * browse lists a connection from where it starts, with the keys following
   * it: the settings menu's sources. The form, if it was open, gives way.
   */
  browse(c: Connection): void {
    if (this.connecting.open) this.showList();
    void this.sources.open(c).then(() => this.reveal());
  }

  /** showList puts the list back where the form was, with the keys in it. */
  private showList(): void {
    this.connecting.hide();
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

  /** show opens the panel with the keys in its list, or in the form while one is open. */
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
   * repoint opens the panel picking a file for the tab with this id, in the
   * folder its file was in: a tab's ! mark, and its line's Re-point.
   */
  repoint(id: string): void {
    const tab = this.sources.tabs.find((t) => t.id === id);
    if (tab === undefined) return;
    if (!this.open) this.show();
    void this.sources.repoint(tab).then(() => this.reveal());
  }

  /** draw lays the list out on the next frame, once however often it is asked. */
  draw(): void {
    if (this.frame !== 0 || this.root.hidden) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  }

  /**
   * search filters every section by what is in the box, and hands the keys
   * back to the list, on the first line left. An S3 object's address is not a
   * filter but the object, so it is added and the box is emptied for the next.
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
   * key reads one key on the list. The arrows move for everyone; j and k only
   * for someone who reads the grid's keys vim's way, since for anyone else a
   * letter is not a motion. A key the panel does not read goes on to the shell,
   * so Ctrl+E and the tab chords still work with the keys here.
   */
  private key(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const vim = this.keys() === "vim-style";
    const page = Math.max(1, Math.floor(this.list.clientHeight / ROW_H) - 1);

    switch (e.key) {
      case "ArrowDown":
        this.move(1);
        break;
      case "ArrowUp":
        this.move(-1);
        break;
      case "PageDown":
        this.move(page);
        break;
      case "PageUp":
        this.move(-page);
        break;
      case "j":
        if (!vim) return;
        this.move(1);
        break;
      case "k":
        if (!vim) return;
        this.move(-1);
        break;
      case "Enter":
        this.choose();
        break;
      case " ":
        this.pick();
        break;
      // What can be done to a tab, from its line. Anywhere else there is no
      // tab, and the key goes on as one the panel does not read.
      case "r":
      case "c":
      case "p":
      case "Delete": {
        const does = DOING_KEYS[e.key];
        const action = this.sources.doings.find((a) => a.does === does);
        if (action === undefined) return;
        this.doing(action);
        break;
      }
      case "Backspace":
        void this.sources.up();
        break;
      case "/":
        this.input.focus();
        this.input.select();
        break;
      case "Escape":
        // Picking a file for a tab is given up before the panel is closed.
        if (this.sources.repointing !== undefined) this.sources.stop();
        else this.hide();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private move(step: number): void {
    this.sources.move(step);
    this.layout();
    this.reveal();
  }

  /** click puts the keys on a line and chooses it, as the keys and Enter would. */
  private click(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".panel-row");
    const index = Number(el?.dataset["row"]);
    if (!Number.isInteger(index)) return;
    const row = rowAt(this.laid, index);
    if (row.t !== "line") return;
    this.sources.focus(row.section, row.line);
    this.layout();
    this.choose();
  }

  /** pick is Space: a file in the browser goes in the selection or out of it. */
  private pick(): void {
    const { section, line } = this.sources.place;
    const entry = section === "browser" ? this.sources.entries[line] : undefined;
    if (entry !== undefined) void this.sources.toggle(entry);
  }

  /**
   * choose is Enter on the line the keys are on: a tab is shown, a connection
   * is browsed and a folder entered. On a file it adds what is picked, a tab
   * each, or the file itself when nothing is, so a single file never needs
   * Space first.
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

  /** reveal scrolls as little as it takes to bring the keys' line into view. */
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
   * layout is the virtualiser: the sizer is as tall as the whole column, and
   * the pool, as many rows as fit and a few over, is moved down it as one
   * element and written into.
   */
  private layout(): void {
    // The form has the list's place, and a listing that lands meanwhile is
    // drawn when the list comes back rather than under the form.
    if (this.connecting.open) return;
    this.laid = spans((s) => this.sources.count(s));
    const total = rowCount(this.laid);
    this.sizer.style.height = `${total * ROW_H}px`;

    const want = poolSize(total, this.list.clientHeight, ROW_H);
    while (this.pool.length < want) {
      const row = document.createElement("div");
      row.append(document.createElement("span"), document.createElement("span"));
      this.pool.push(row);
      this.rows.append(row);
    }
    while (this.pool.length > want) this.pool.pop()?.remove();

    const first = firstRow(total, this.pool.length, this.list.scrollTop, ROW_H);
    this.rows.style.transform = `translateY(${first * ROW_H}px)`;
    const at = this.sources.place;
    for (let i = 0; i < this.pool.length; i++) this.paint(this.pool[i]!, first + i, at);

    // The rest of the folder is asked for as the end of it comes on screen,
    // and not before: a prefix of 200,000 is read as far as someone scrolls.
    // `next` sends nothing while a page is already coming.
    if (this.sources.more && first + this.pool.length >= total) void this.sources.next();

    this.paintPeek();
    this.paintFoot();
  }

  /** press hands a button's files to the shell: to add, or to point a tab at. */
  private press(b: Button): void {
    if (b.to === undefined) return this.act.add(b.refs, b.one);
    this.sources.stop();
    this.act.repoint(b.to, b.refs[0]!);
  }

  /**
   * give is one file chosen without the buttons, by Enter or by its address:
   * the tab being picked for is pointed at it, and otherwise it is added.
   */
  private give(ref: SourceRef): void {
    const to = this.sources.repointing;
    if (to === undefined) return this.act.add([ref], false);
    this.sources.stop();
    this.act.repoint(to.id, ref);
  }

  /** doing is one of a tab's buttons, or its key. Re-pointing starts in the browser. */
  private doing(a: TabAction): void {
    switch (a.does) {
      case "reload":
        return this.act.reload(a.id);
      case "remove":
        return this.act.remove(a.id);
      case "repoint":
        return this.repoint(a.id);
      case "connect":
        return this.connectFor(a.id);
    }
  }

  /**
   * connectFor opens the connect form for the bucket a tab reads that no
   * connection covers, with the bucket filled in: the tab's ! mark, and its
   * line's Connect. A tab that has closed, or that needs no connection, opens
   * nothing.
   */
  connectFor(id: string): void {
    const bucket = this.sources.tabs.find((t) => t.id === id)?.link?.connect?.bucket;
    if (bucket !== undefined) this.connect({ bucket });
  }

  /** paintPeek draws the header and first rows of the one picked file. */
  private paintPeek(): void {
    const s = this.sources;
    const now = s.peeking ? "reading" : s.peeked;
    if (now === this.drawnPeek) return;
    this.drawnPeek = now;
    this.peek.hidden = now === undefined;
    if (now === undefined) return this.peek.replaceChildren();
    if (now === "reading") {
      this.peek.replaceChildren(text("div", "note", "reading the front of it…"));
      return;
    }

    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const h of now.header) head.append(text("th", "", h));
    const body = table.createTBody();
    for (const row of now.rows) {
      const tr = body.insertRow();
      for (const cell of row) tr.append(text("td", "", cell));
    }
    const wrap = document.createElement("div");
    wrap.className = "table";
    wrap.append(table);
    this.peek.replaceChildren(text("div", "note", now.label), wrap);
  }

  /**
   * paintFoot draws what can be done to the tab the keys are on, then the
   * buttons for what is picked, and nothing while there is neither.
   */
  private paintFoot(): void {
    const doings = this.sources.doings;
    const buttons = this.sources.buttons;
    const key = [
      ...doings.map((a) => a.does + a.id),
      ...buttons.map(
        (b) => b.label + (b.to ?? "") + b.refs.map((r) => ("path" in r ? r.path : r.name)).join(),
      ),
    ].join("|");
    if (key === this.drawnFoot) return;
    this.drawnFoot = key;
    this.foot.hidden = doings.length === 0 && buttons.length === 0;
    this.foot.replaceChildren(
      ...doings.map((a) => {
        const el = text("button", "", a.label);
        el.addEventListener("click", () => this.doing(a));
        return el;
      }),
      ...buttons.map((b) => {
        const el = text("button", b.one ? "" : "primary", b.label);
        el.addEventListener("click", () => this.press(b));
        return el;
      }),
    );
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
      name = pointing === undefined ? TITLES[row.section] : `Point ${pointing.name} at…`;
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
      const tab = row.section === "workspace" ? this.sources.tabs[row.line] : undefined;
      if (tab !== undefined) {
        const state = stateOf(tab);
        if (state !== "fine") cls += ` ${state}`;
        // Where it lives, and what is wrong with it, for whoever hovers.
        title = [tab.link?.path, tab.link?.missing ?? tab.link?.changed]
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

  /** line is what one line of a section says: its name, and what is beside it. */
  private line(section: Section, line: number): [string, string] {
    switch (section) {
      case "workspace": {
        const t = this.sources.tabs[line];
        if (t === undefined) return ["", ""];
        const state = stateOf(t);
        if (state !== "fine") return [t.name, STATE_WORDS[state]];
        return [t.name, t.bytes === undefined ? "" : formatBytes(t.bytes)];
      }
      case "connections": {
        if (this.sources.isConnect(line)) return ["+ Connect a bucket", ""];
        const c = this.sources.connections[line];
        if (c === undefined) return ["", ""];
        return [c.name, c.where === undefined ? c.kind : `${c.kind} · ${c.where}`];
      }
      case "browser": {
        const e = this.sources.entries[line];
        if (e === undefined) return ["", ""];
        if (e.folder) return [`${e.name}/`, ""];
        return [e.name, e.bytes === undefined ? "—" : formatBytes(e.bytes)];
      }
    }
  }

  /** note is what a section with no lines says instead, so empty is never unexplained. */
  private note(section: Section): string {
    const s = this.sources;
    if (section === "browser") {
      if (s.reading) return "reading…";
      if (s.trouble !== "") return s.trouble;
      if (s.path === "") return "choose a connection to browse it";
    }
    if (s.filter !== "") return `nothing matches "${s.filter}"`;
    switch (section) {
      case "workspace":
        return "no sources open";
      case "connections":
        return "no connections yet";
      case "browser":
        return "this folder is empty";
    }
  }
}

function text(tag: string, cls: string, content: string): HTMLElement {
  const el = document.createElement(tag);
  if (cls !== "") el.className = cls;
  el.textContent = content;
  return el;
}

/** set writes text only when it changed, since the pool is repainted on every scroll. */
function set(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
