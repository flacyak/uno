// State for the sources panel beside the grid: the open tabs, the saved
// connections, and the folder being browsed.
//
// The three sections form one column of lines. The keyboard focus is always
// on one section and one line in it, and moving past the end of a section
// carries into the next.
//
// This file is plain logic, so tests run it directly. Late listing and
// peek responses are dropped by comparing request counters.

import type { Link, PartInfo, Peeked, SourceRef } from "@uno/grid/engine";
import { compareStrings } from "@uno/grid/go";
import type { Connection as Saved } from "@uno/grid/library";
import type { Entry, HeaderMode, Listing, PartsRef, SingleRef } from "@uno/grid/store";
import { s3Location, s3Url } from "@uno/grid/store/s3";

import { m } from "../paraglide/messages.js";
import { num } from "./locale.ts";
import { said } from "./said.ts";

/**
 * The two engine methods the panel uses. `Workspace` implements it; tests
 * use a stub.
 */
export interface Listings {
  /** One page of a folder or prefix. */
  list(path: string, cursor?: string): Promise<Listing>;
  /** The front of one file: its format, header and first rows. */
  peek(ref: SourceRef): Promise<Peeked>;
}

/**
 * The fields of a tab the panel reads. `Tab` satisfies it; tests build the
 * smaller shape directly.
 */
export interface Open {
  readonly id: string;
  readonly name: string;
  /** The file behind the tab, if it has one. */
  readonly link?: Link;
  /** The file's size when the tab opened. */
  readonly bytes?: number;
  /**
   * The version the bucket holds now, when it differs from the one this tab
   * reads. Set by the workspace when the window gains focus.
   */
  readonly newer?: string;
  /** The files read as one, in order, for a multi-file tab. */
  readonly parts?: readonly PartInfo[];
}

/**
 * A source that was asked for and is still opening. Shown as a line under
 * the tabs.
 */
export interface Arriving {
  readonly name: string;
  /**
   * The refusal message for a connection that failed. Its line stays, and
   * choosing it reopens the connection form.
   */
  readonly failed?: string;
}

/** The label shown beside an arriving source's name. */
export function opening(): string {
  return m.sources_opening();
}

/** The label shown beside a connection that is being tried. */
export function connecting(): string {
  return m.sources_connecting();
}

/** The label shown beside a connection that was refused. */
export function failed(): string {
  return m.sources_failed();
}

/**
 * The state of the file behind a tab: fine, changed since the log was
 * written, missing, in a bucket awaiting a connection, or with a newer
 * version in its bucket.
 */
export type State = "fine" | "changed" | "missing" | "unconnected" | "newer";

/**
 * The label shown beside a tab in a changed, missing, unconnected or newer
 * state.
 */
export function stateWord(state: Exclude<State, "fine">): string {
  return STATE_WORDS[state]();
}

const STATE_WORDS: Record<Exclude<State, "fine">, () => string> = {
  changed: m.state_changed,
  missing: m.state_missing,
  unconnected: m.state_unconnected,
  newer: m.state_newer,
};

/**
 * Returns a tab's state. When several apply, the order of priority is
 * unconnected, missing, newer, changed.
 */
export function stateOf(tab: Open): State {
  if (tab.link?.connect !== undefined) return "unconnected";
  if (tab.link?.missing !== undefined) return "missing";
  if (tab.newer !== undefined) return "newer";
  if (tab.link?.changed !== undefined) return "changed";
  return "fine";
}

/** An action that can be taken on the focused tab. */
export type Doing = "reload" | "repoint" | "remove" | "connect" | "append";

/** One action button on a workspace line. */
export interface TabAction {
  label: string;
  does: Doing;
  /** The tab the action applies to. */
  id: string;
  /** The files an append adds, in listing order. */
  files?: readonly SingleRef[];
}

/**
 * How files added as one source are read: whether each has a header row, and
 * whether a `_file` column records which file each row came from.
 */
export interface Joining {
  header: HeaderMode;
  fileColumn: boolean;
}

/**
 * New files found in a multi-file tab's folder: those that sort after the
 * tab's last part and are new to its parts.
 */
export interface Grown {
  /** The folder as shown to a person: shop/2025/. */
  folder: string;
  /** The new files, in listing order. */
  files: readonly SingleRef[];
}

/** Formats a count of new files: "3 new files". */
export function newFiles(n: number): string {
  return m.files_new_count({ count: n });
}

/** Formats a count of files: "3 files". */
export function fileCount(n: number): string {
  return m.files_count({ count: n });
}

/**
 * A place that can be browsed, as the panel lists it:
 * `acme-exports · s3 · eu-west-1`, `~/exports · disk`.
 *
 * The shell builds these from the engine's saved connections with
 * `connectionLine` and hands them to the panel.
 */
export interface Connection {
  /** The id of the .unof it was read from. */
  id?: string;
  /** The display name: the bucket or folder. */
  name: string;
  /** The path browsing starts at: s3://acme-exports, /home/jo/exports. */
  path: string;
  /** The kind of place: "s3", "disk". */
  kind: string;
  /** The region, for a kind that has one: "eu-west-1". */
  where?: string;
}

/** Builds a panel Connection from a saved connection. */
export function connectionLine(c: Saved): Connection {
  const path = c.prefix === "" ? `s3://${c.bucket}` : `s3://${c.bucket}/${c.prefix}`;
  const line: Connection = {
    id: c.id,
    name: c.name === "" ? c.id : c.name,
    path,
    kind: c.provider,
  };
  if (c.region !== undefined) line.where = c.region;
  return line;
}

/** The sections, in draw and navigation order. */
export type Section = "workspace" | "connections" | "browser";

export const SECTIONS: readonly Section[] = ["workspace", "connections", "browser"];

/** The keyboard focus: a section and a line in it. */
export interface Place {
  section: Section;
  line: number;
}

/** One step of the breadcrumb: the connection, then each folder entered. */
export interface Crumb {
  name: string;
  path: string;
}

/**
 * A button under the browser. The panel builds the refs; the shell opens
 * them.
 */
export interface Button {
  /** The button text: "Add 3", "Add as one", "Point ledger.csv here". */
  label: string;
  /** Whether the files become one source, or a tab each. */
  one: boolean;
  /** The refs to open: one per file in listing order, or one PartsRef
   * covering all of them. */
  refs: readonly SourceRef[];
  /** The tab to re-point, set while re-pointing. */
  to?: string;
}

/**
 * The file extensions a person can pick. Other files are listed only.
 * Grows as ingest adds formats.
 */
const READS: readonly string[] = [".csv", ".tsv"];

/** Case-insensitive substring match. An empty query matches everything. */
function matches(name: string, query: string): boolean {
  return query === "" || name.toLowerCase().includes(query);
}

/**
 * Parses the search text as an S3 object URL (s3:// or https form). Returns
 * a ref named after the object, or undefined for other text and for a
 * prefix (key ending in a slash).
 */
function address(typed: string): SourceRef | undefined {
  const loc = s3Location(typed);
  if (loc === undefined || loc.key.endsWith("/")) return undefined;
  return { name: loc.key.slice(loc.key.lastIndexOf("/") + 1), path: s3Url(loc) };
}

/**
 * Returns the breadcrumb trail to the folder a file is in.
 *
 * For an S3 path the trail starts at the bucket and has one crumb per
 * folder, each path keeping its trailing slash. For a disk path the trail is
 * the folder alone. Returns undefined for a bare file name.
 */
export function trailTo(path: string): Crumb[] | undefined {
  const loc = s3Location(path);
  if (loc !== undefined) {
    const trail: Crumb[] = [{ name: loc.bucket, path: `s3://${loc.bucket}` }];
    const folders = loc.key.split("/").slice(0, -1);
    let key = "";
    for (const f of folders) {
      key += `${f}/`;
      trail.push({ name: f, path: s3Url({ bucket: loc.bucket, key }) });
    }
    return trail;
  }
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return undefined;
  const folder = cut === 0 ? path.slice(0, 1) : path.slice(0, cut);
  const name = folder.slice(Math.max(folder.lastIndexOf("/"), folder.lastIndexOf("\\")) + 1);
  return [{ name: name === "" ? folder : name, path: folder }];
}

/** The characters that separate words in a file name. */
const BREAKS = "-_. ";

/**
 * Returns the name for several files added as one: the shared prefix of
 * their stems, cut back to a whole word, plus the first file's extension.
 * `orders-2025-01.csv` and `orders-2025-02.csv` give `orders-2025.csv`.
 *
 * When the shared prefix is empty, the name is the first file's folder, or
 * the first file's stem for a bare file name.
 */
export function joinedName(files: ReadonlyArray<{ name: string; path: string }>): string {
  const first = files[0];
  if (first === undefined) return "";
  const dot = first.name.lastIndexOf(".");
  const extension = dot > 0 ? first.name.slice(dot) : "";
  const stems = files.map((f) => {
    const at = f.name.lastIndexOf(".");
    return at > 0 ? f.name.slice(0, at) : f.name;
  });

  let shared = stems[0]!;
  for (const stem of stems) {
    let same = 0;
    while (same < shared.length && shared[same] === stem[same]) same++;
    shared = shared.slice(0, same);
  }
  // Cut back to a word boundary in every name, so `ads-q3` and `ads-q4`
  // share `ads`.
  const whole = (end: number): boolean =>
    BREAKS.includes(shared[end - 1]!) ||
    stems.every((stem) => stem.length === end || BREAKS.includes(stem[end]!));
  let end = shared.length;
  while (end > 0 && !whole(end)) end--;
  while (end > 0 && BREAKS.includes(shared[end - 1]!)) end--;

  const base = shared.slice(0, end) || trailTo(first.path)?.at(-1)?.name || stems[0]!;
  return base + extension;
}

/**
 * Returns the folder a file is in, as a path to list and as a label:
 * s3://acme-exports/shop/2025/ and `shop/2025/`. An S3 object's label is its
 * prefix, or the bucket name for an object at the top. A disk file's label
 * is the folder name. Undefined for a bare file name.
 */
function folderOf(path: string): { path: string; said: string } | undefined {
  const last = trailTo(path)?.at(-1);
  if (last === undefined) return undefined;
  const key = s3Location(path)?.key ?? "";
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  return { path: last.path, said: prefix === "" ? `${last.name}/` : prefix };
}

/** Clamps a line index to [0, count - 1]. */
function bound(line: number, count: number): number {
  return Math.max(0, Math.min(line, count - 1));
}

export class Sources {
  private saved: readonly Connection[];
  private found: readonly Entry[] = [];
  private trail: readonly Crumb[] = [];
  private at: Place = { section: "workspace", line: 0 };
  /**
   * Counter for listing requests. Each `browse` increments it, and a response
   * is dropped if the counter has moved on.
   */
  private asked = 0;
  private waiting = false;
  private refused = "";
  /**
   * The cursor for the next page of the browsed folder, or undefined once
   * the last page has landed.
   */
  private cursor: string | undefined;
  /**
   * Whether a later page is in flight. `next` is called on every scroll near
   * the end of the list, and this makes repeat calls no-ops.
   */
  private paging = false;
  /**
   * The selected file paths. They are read back through the page so the
   * selection comes out in listing order, whatever order they were picked.
   */
  private readonly picks = new Set<string>();
  /** Incremented on every change to `picks`, so caches can detect a change. */
  private picked = 0;
  /**
   * Cache of `selected`, keyed on the page and `picked` it was computed
   * from.
   */
  private selection:
    | { from: readonly Entry[]; picked: number; entries: readonly Entry[] }
    | undefined;
  /**
   * Cache of each path's index in the page, keyed on the page it was built
   * from. `carry` extends it when a later page lands.
   */
  private where: { from: readonly Entry[]; at: Map<string, number> } | undefined;
  private shown: Peeked | undefined;
  private looking = false;
  /** Counter for peek requests, used the same way as `asked`. */
  private looked = 0;
  /** The filter text, lower-cased. "" matches everything. */
  private query = "";
  /** The S3 object the last search named, if it was an S3 URL. */
  private address: SourceRef | undefined;
  /**
   * Cache of the filtered browser entries, keyed on the page and query it
   * was computed from. `next` replaces `found` with a new array so that the
   * cache is invalidated when a page lands.
   */
  private kept: { from: readonly Entry[]; query: string; entries: readonly Entry[] } | undefined;
  /** The tab a file is being picked for, while re-pointing. */
  private pointing: Open | undefined;
  /** The current Joining choices. Kept between picks. */
  private how: Joining = { header: "first", fileColumn: false };
  /**
   * The new files found for each multi-file tab, by tab id, with the path of
   * the tab's last part at the time. An entry is ignored once the tab's last
   * part changes.
   */
  private readonly gained = new Map<string, { after: string; grown: Grown }>();
  /** The connection being tried or the one that was refused, if any. */
  private trying: Arriving | undefined;

  constructor(
    private readonly listings: Listings,
    /** Returns the open tabs. Called on every read, since the workspace
     * changes them on its own. */
    private readonly opened: () => readonly Open[],
    connections: readonly Connection[] = [],
    /** Called when something changed and the panel should redraw. */
    private readonly changed: () => void = () => {},
    /** Returns the sources still opening. Called on every read, like `opened`. */
    private readonly arriving: () => readonly Arriving[] = () => [],
  ) {
    this.saved = connections;
  }

  /** The open tabs that pass the filter. */
  get tabs(): readonly Open[] {
    return this.filtered(this.opened());
  }

  /**
   * The sources still opening that pass the filter. They are the last lines
   * of the workspace section.
   */
  get opening(): readonly Arriving[] {
    return this.filtered(this.arriving());
  }

  /** The saved connections that pass the filter, matched by name or path. */
  get connections(): readonly Connection[] {
    return this.filtered(this.saved, (c) => c.path);
  }

  /** Filters a list by name, or by `also`, with the current query. */
  private filtered<T extends { name: string }>(
    all: readonly T[],
    also?: (t: T) => string,
  ): readonly T[] {
    const q = this.query;
    if (q === "") return all;
    return all.filter((t) => matches(t.name, q) || (also !== undefined && matches(also(t), q)));
  }

  set connections(list: readonly Connection[]) {
    this.saved = list;
  }

  /**
   * The connection being tried or refused, if it passes the filter. It is
   * the line after the saved connections.
   */
  get connecting(): Arriving | undefined {
    const trying = this.trying;
    if (trying === undefined || this.query === "") return trying;
    return matches(trying.name, this.query) ? trying : undefined;
  }

  /** Sets or clears the connection being tried. */
  connect(trying: Arriving | undefined): void {
    this.trying = trying;
  }

  /** The number of connection lines before the "connect another" line. */
  private get connected(): number {
    return this.connections.length + (this.connecting === undefined ? 0 : 1);
  }

  /**
   * Whether a connections line is the "connect another" line, which is the
   * last line of the section. Hidden while a filter is active.
   */
  isConnect(line: number): boolean {
    return this.query === "" && line === this.connected;
  }

  /** The browsed folder's entries that pass the filter. Cached per page and query. */
  get entries(): readonly Entry[] {
    const q = this.query;
    if (q === "") return this.found;
    const kept = this.kept;
    if (kept !== undefined && kept.from === this.found && kept.query === q) return kept.entries;
    const entries = this.found.filter((e) => matches(e.name, q));
    this.kept = { from: this.found, query: q, entries };
    return entries;
  }

  /**
   * The action buttons for the focused tab: connect or reload, then append
   * if the folder has new files, then repoint for a single-file tab, then
   * remove while another tab remains. Empty while the focus is elsewhere.
   */
  get doings(): readonly TabAction[] {
    const { section, line } = this.place;
    const tab = section === "workspace" ? this.tabs[line] : undefined;
    if (tab === undefined) return [];
    const id = tab.id;
    const out: TabAction[] = [];
    // An unconnected tab offers connect; a connected one offers reload.
    const unconnected = tab.link?.connect;
    if (unconnected !== undefined) {
      out.push({
        label: m.sources_connect_bucket({ bucket: unconnected.bucket }),
        does: "connect",
        id,
      });
    } else if (tab.link !== undefined) {
      out.push({ label: m.action_reload(), does: "reload", id });
    }
    const grown = this.grown(tab);
    if (grown !== undefined) {
      out.push({
        label: m.sources_append_new({ count: grown.files.length, folder: grown.folder }),
        does: "append",
        id,
        files: grown.files,
      });
    }
    // Only a single-file tab is re-pointed. A multi-file tab is appended to.
    if (tab.parts === undefined) out.push({ label: m.action_repoint(), does: "repoint", id });
    if (this.opened().length > 1) out.push({ label: m.action_remove(), does: "remove", id });
    return out;
  }

  /**
   * The new files last found for a multi-file tab, or undefined if there are
   * none or the tab's parts have changed since.
   */
  grown(tab: Open): Grown | undefined {
    const found = this.gained.get(tab.id);
    return found !== undefined && found.after === tab.parts?.at(-1)?.path ? found.grown : undefined;
  }

  /**
   * Lists the folder of every multi-file tab and records the files that
   * sort after the tab's last part. Also relists the browsed folder. Called
   * when the panel opens and when the window gains focus.
   *
   * Only files after the last part are offered, so appending keeps every
   * existing row in place. A folder that fails to list drops the tab's record.
   */
  async askGrown(): Promise<void> {
    const tabs = this.opened();
    for (const id of this.gained.keys()) {
      if (!tabs.some((t) => t.id === id)) this.gained.delete(id);
    }
    await Promise.all([...tabs.map((tab) => this.askAfter(tab)), this.again()]);
    this.changed();
  }

  /**
   * Relists the browsed folder, reading as many pages as were loaded before,
   * and replaces the entries. The old entries stay while waiting. The result
   * is dropped if the person browsed elsewhere or paged further meanwhile.
   */
  private async again(): Promise<void> {
    const path = this.path;
    if (path === "" || this.waiting || this.paging) return;
    const mine = this.asked;
    const was = this.found;

    const entries: Entry[] = [];
    let cursor: string | undefined;
    try {
      for await (const page of this.pages(path)) {
        // Push each entry: a spread would copy all so far once per page.
        for (const entry of page.entries) entries.push(entry);
        cursor = page.next;
        if (entries.length >= was.length) break;
      }
    } catch {
      // On failure the old entries stay.
      return;
    }
    if (mine !== this.asked || was !== this.found || this.paging) return;
    this.found = entries;
    this.cursor = cursor;
    // Drop picks missing from the relisted folder, using the index for speed.
    if (this.picks.size > 0) {
      const at = this.index();
      for (const pick of this.picks) if (!at.has(pick)) this.unpick(pick);
    }
    if (this.at.section === "browser") {
      this.at = { section: "browser", line: bound(this.at.line, this.entries.length) };
    }
  }

  /** Yields a folder's listing one page at a time through the last page. */
  private async *pages(path: string): AsyncGenerator<Listing> {
    let cursor: string | undefined;
    do {
      const page = await this.listings.list(path, cursor);
      yield page;
      cursor = page.next;
    } while (cursor !== undefined);
  }

  /** Finds new files for one multi-file tab and records them in `gained`. */
  private async askAfter(tab: Open): Promise<void> {
    const last = tab.parts?.at(-1);
    const folder = last === undefined ? undefined : folderOf(last.path);
    if (tab.parts === undefined || last === undefined || folder === undefined) return;
    const have = new Set(tab.parts.map((part) => part.path));

    const files: SingleRef[] = [];
    try {
      for await (const page of this.pages(folder.path)) {
        for (const entry of page.entries) {
          const after = compareStrings(entry.name, last.name) > 0;
          if (after && this.selectable(entry) && !have.has(entry.path)) {
            files.push({ name: entry.name, path: entry.path });
          }
        }
      }
    } catch {
      this.gained.delete(tab.id);
      return;
    }
    if (files.length === 0) this.gained.delete(tab.id);
    else this.gained.set(tab.id, { after: last.path, grown: { folder: folder.said, files } });
  }

  /**
   * The tab a file is being picked for, while re-pointing and the tab is
   * still open. Undefined otherwise.
   */
  get repointing(): Open | undefined {
    const p = this.pointing;
    return p !== undefined && this.opened().some((t) => t.id === p.id) ? p : undefined;
  }

  /**
   * Starts picking a file for a tab. Clears the selection, browses the
   * folder the tab's file was in (or stays where the browser is for an
   * unlinked tab), and moves focus to the browser.
   */
  async repoint(tab: Open): Promise<void> {
    this.pointing = tab;
    const trail = tab.link === undefined ? undefined : trailTo(tab.link.path);
    if (trail === undefined) {
      this.forget();
      this.focus("browser");
      this.changed();
      return;
    }
    this.trail = trail;
    this.focus("browser");
    await this.browse(trail[trail.length - 1]!.path);
  }

  /** Ends re-pointing and clears the selection. */
  stop(): void {
    if (this.pointing === undefined) return;
    this.pointing = undefined;
    this.forget();
    this.changed();
  }

  /** The current filter text, lower-cased. */
  get filter(): string {
    return this.query;
  }

  /**
   * The S3 object the last search named, for the shell to open as a tab.
   * Undefined when the search was a plain filter.
   */
  get pasted(): SourceRef | undefined {
    return this.address;
  }

  /**
   * Sets the filter and moves focus to the first remaining line.
   *
   * Text that parses as an S3 object URL is stored in `pasted` and the
   * filter is cleared. It is parsed before lower-casing, since S3 keys are
   * case-sensitive.
   */
  search(text: string): void {
    this.address = address(text);
    this.query = this.address === undefined ? text.trim().toLowerCase() : "";
    this.at = { section: "workspace", line: 0 };
    if (this.count("workspace") === 0) this.one(1);
  }

  /** The breadcrumb trail from the connection down. Empty until one is opened. */
  get crumb(): readonly Crumb[] {
    return this.trail;
  }

  /** The path being browsed, or "" before a connection has been opened. */
  get path(): string {
    return this.trail[this.trail.length - 1]?.path ?? "";
  }

  /**
   * Whether the first page of the browsed folder is in flight. Later pages
   * are reported by `more`.
   */
  get reading(): boolean {
    return this.waiting;
  }

  /** Whether the browsed folder has another page to load. */
  get more(): boolean {
    return this.cursor !== undefined;
  }

  /** The refusal message from the last listing, or "" if it succeeded. */
  get trouble(): string {
    return this.refused;
  }

  /**
   * The selected files in listing order. Cached per page and `picked`.
   *
   * Reads the whole page, so picks made under one filter stay selected
   * under another.
   */
  get selected(): readonly Entry[] {
    if (this.picks.size === 0) return [];
    const kept = this.selection;
    if (kept !== undefined && kept.from === this.found && kept.picked === this.picked) {
      return kept.entries;
    }
    const at = this.index();
    const lines: number[] = [];
    for (const pick of this.picks) {
      const line = at.get(pick);
      if (line !== undefined) lines.push(line);
    }
    lines.sort((a, b) => a - b);
    const entries = lines.map((line) => this.found[line]!);
    this.selection = { from: this.found, picked: this.picked, entries };
    return entries;
  }

  /** Returns a map from path to line index for the current page. Cached per page. */
  private index(): ReadonlyMap<string, number> {
    const found = this.found;
    const where = this.where;
    if (where !== undefined && where.from === found) return where.at;
    const at = new Map<string, number>();
    for (let line = 0; line < found.length; line++) at.set(found[line]!.path, line);
    this.where = { from: found, at };
    return at;
  }

  /** Whether an entry is selected. */
  chosen(entry: Entry): boolean {
    return this.picks.has(entry.path);
  }

  /** Whether an entry can be selected: a file with an extension in READS. */
  selectable(entry: Entry): boolean {
    if (entry.folder) return false;
    const dot = entry.name.lastIndexOf(".");
    return dot > 0 && READS.includes(entry.name.slice(dot).toLowerCase());
  }

  /**
   * The buttons under the browser: empty until a file is picked; "Point here"
   * while re-pointing; "Add 1" for one file; "Add N" and "Add as one" for
   * several. "Add as one" builds one PartsRef in listing order, using the
   * current Joining choices.
   */
  get buttons(): readonly Button[] {
    const refs = this.selected.map((e) => ({ name: e.name, path: e.path }));
    if (refs.length === 0) return [];
    const pointing = this.repointing;
    if (pointing !== undefined) {
      return [
        { label: m.sources_point_here({ name: pointing.name }), one: false, refs, to: pointing.id },
      ];
    }
    const each: Button = {
      label: m.sources_add_count({ count: num(refs.length) }),
      one: false,
      refs,
    };
    if (refs.length === 1) return [each];
    const joined: PartsRef = {
      name: joinedName(refs),
      parts: refs.map((ref) => ({ ref })),
      header: this.how.header,
    };
    if (this.how.fileColumn) joined.fileColumn = true;
    return [each, { label: m.sources_add_as_one(), one: true, refs: [joined] }];
  }

  /**
   * The Joining choices while "Add as one" is offered, else undefined.
   */
  get joining(): Joining | undefined {
    return this.selected.length > 1 && this.repointing === undefined ? this.how : undefined;
  }

  /** Updates the Joining choices. They persist for later picks. */
  join(how: Partial<Joining>): void {
    this.how = { ...this.how, ...how };
    this.changed();
  }

  /** The peek of the single selected file, once loaded. Undefined otherwise. */
  get peeked(): Peeked | undefined {
    return this.shown;
  }

  /** Whether a peek is in flight. */
  get peeking(): boolean {
    return this.looking;
  }

  /**
   * The focused section and line. The line is clamped on read, since tabs
   * can close between draws on their own.
   */
  get place(): Place {
    return { section: this.at.section, line: bound(this.at.line, this.count(this.at.section)) };
  }

  /** The number of lines in a section. */
  count(section: Section): number {
    switch (section) {
      case "workspace":
        return this.tabs.length + this.opening.length;
      case "connections":
        return this.connected + (this.query === "" ? 1 : 0);
      case "browser":
        return this.entries.length;
    }
  }

  /**
   * Moves focus to a section, at the given line or its first. An empty
   * section can hold focus.
   */
  focus(section: Section, line = 0): void {
    this.at = { section, line: bound(line, this.count(section)) };
  }

  /** Moves focus by `step` lines: down for positive, up for negative. */
  move(step: number): void {
    for (let i = Math.abs(step); i > 0; i--) this.one(Math.sign(step));
  }

  /**
   * Moves focus one line. At the end of a section, moves to the first or
   * last line of the next non-empty section in that direction. Stays put at
   * either end of the column.
   */
  private one(way: number): void {
    const from = this.place;
    const line = from.line + way;
    if (line >= 0 && line < this.count(from.section)) {
      this.at = { section: from.section, line };
      return;
    }
    for (let i = SECTIONS.indexOf(from.section) + way; i >= 0 && i < SECTIONS.length; i += way) {
      const section = SECTIONS[i]!;
      const lines = this.count(section);
      if (lines > 0) {
        this.at = { section, line: way > 0 ? 0 : lines - 1 };
        return;
      }
    }
  }

  /** Browses a connection from its root and moves focus to the browser. */
  async open(connection: Connection): Promise<void> {
    this.trail = [{ name: connection.name, path: connection.path }];
    this.focus("browser");
    await this.browse(connection.path);
  }

  /** Browses a folder entry of the current folder. */
  async enter(entry: Entry): Promise<void> {
    if (!entry.folder) return;
    this.trail = [...this.trail, { name: entry.name, path: entry.path }];
    await this.browse(entry.path);
  }

  /** Browses the parent folder. Stays put at the connection root. */
  async up(): Promise<void> {
    if (this.trail.length < 2) return;
    this.trail = this.trail.slice(0, -1);
    await this.browse(this.trail[this.trail.length - 1]!.path);
  }

  /**
   * Lists the first page of a path and replaces the browser's entries.
   * Clears the entries, caches, selection and cursor first. The response is
   * dropped if another browse started meanwhile.
   */
  private async browse(path: string): Promise<void> {
    const mine = ++this.asked;
    this.found = [];
    // Drop the caches for the old page so it can be garbage collected.
    this.kept = undefined;
    this.where = undefined;
    this.refused = "";
    this.waiting = true;
    // A page still in flight for the old folder is dropped when it lands.
    this.cursor = undefined;
    this.paging = false;
    this.forget();
    if (this.at.section === "browser") this.at = { section: "browser", line: 0 };
    this.changed();

    try {
      const listing = await this.listings.list(path);
      if (mine !== this.asked) return;
      this.found = listing.entries;
      this.cursor = listing.next;
    } catch (err) {
      if (mine !== this.asked) return;
      // The refusal is shown where the entries would be.
      this.refused = said(err);
    }
    this.waiting = false;
    this.changed();
  }

  /**
   * Loads the next page of the browsed folder and appends it to the entries.
   * Returns at once on the last page or while a page is in flight. The
   * response is dropped if another browse started meanwhile.
   */
  async next(): Promise<void> {
    const cursor = this.cursor;
    if (cursor === undefined || this.paging) return;
    const mine = this.asked;
    this.paging = true;

    try {
      const listing = await this.listings.list(this.path, cursor);
      if (mine !== this.asked) return;
      // A new array: the caches are keyed on array identity.
      const was = this.found;
      this.found = [...was, ...listing.entries];
      this.carry(was, listing.entries);
      this.cursor = listing.next;
      this.refused = "";
    } catch (err) {
      if (mine !== this.asked) return;
      // The loaded pages and the cursor stay, so the next scroll retries.
      this.refused = said(err);
    }
    this.paging = false;
    this.changed();
  }

  /**
   * Extends the path index with the entries that just landed, if the index
   * was built from the previous page. Otherwise leaves it for the next
   * `index()` call to rebuild.
   */
  private carry(was: readonly Entry[], landed: readonly Entry[]): void {
    const where = this.where;
    if (where === undefined || where.from !== was) return;
    for (let i = 0; i < landed.length; i++) where.at.set(landed[i]!.path, was.length + i);
    this.where = { from: this.found, at: where.at };
  }

  /**
   * Toggles an entry's selection. Ignores an unselectable entry.
   */
  async toggle(entry: Entry): Promise<void> {
    if (!this.selectable(entry)) return;
    // While re-pointing only one file can be selected, so a pick replaces the last.
    const had = this.picks.has(entry.path);
    if (this.repointing !== undefined) this.picks.clear();
    if (had) this.picks.delete(entry.path);
    else this.picks.add(entry.path);
    this.picked++;
    await this.look();
  }

  /**
   * Deselects the files in `refs` once they have been added to the
   * workspace. Files picked since stay selected.
   */
  added(refs: readonly SourceRef[]): void {
    for (const ref of refs) {
      const files = "parts" in ref ? ref.parts.map((part) => part.ref) : [ref];
      for (const file of files) if ("path" in file) this.unpick(file.path);
    }
    void this.look();
  }

  /** Deselects one path, if selected. */
  private unpick(path: string): void {
    if (this.picks.delete(path)) this.picked++;
  }

  /** Clears the selection and the peek, and cancels any peek in flight. */
  private forget(): void {
    this.picks.clear();
    this.picked++;
    this.shown = undefined;
    this.looking = false;
    this.looked++;
  }

  /**
   * Peeks the single selected file, if exactly one is selected. The
   * response is dropped if the selection changed meanwhile.
   */
  private async look(): Promise<void> {
    const mine = ++this.looked;
    const picked = this.selected;
    const one = picked.length === 1 ? picked[0] : undefined;
    this.shown = undefined;
    this.looking = one !== undefined;
    this.changed();
    if (one === undefined) return;

    try {
      const peeked = await this.listings.peek({ name: one.name, path: one.path });
      if (mine !== this.looked) return;
      this.shown = peeked;
    } catch {
      // A failed peek leaves the preview empty. The file can still be added.
      if (mine !== this.looked) return;
    }
    this.looking = false;
    this.changed();
  }
}
