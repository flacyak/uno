// The panel beside the grid: what is open, the places files come from, and the
// one being browsed now.
//
// The three sections are one column of lines, which is what lets a person work
// the panel without a mouse: the keys are always in a section and on a line in
// it, and moving off the end of one carries into the next.
//
// It holds no widgets, for the reason the workspace holds none. Browsing is
// where the mistakes are -- a listing that lands after the person has moved on,
// a crumb that says one place while the entries are another, a peek of a file
// nobody has selected any more -- and all of it is tested here without a
// window.

import type { Link, PartInfo, Peeked, SourceRef } from "@uno/grid/engine";
import { compareStrings } from "@uno/grid/go";
import type { Connection as Saved } from "@uno/grid/library";
import type { Entry, HeaderMode, Listing, PartsRef, SingleRef } from "@uno/grid/store";
import { s3Location, s3Url } from "@uno/grid/store/s3";

import { m } from "../paraglide/messages.js";
import { num } from "./locale.ts";
import { said } from "./said.ts";

/**
 * Listings is the whole of what the panel needs an engine for.
 *
 * `Engine.list` and `Engine.peek` are ones without being told so, which is the
 * point: a test browses a stand-in that answers out of a map, and the panel
 * never holds an engine it could reach further into. It is narrower than
 * store's `Lister` as well, since which lister claims a path is the engine's
 * business and the panel only ever has a path and asks.
 */
export interface Listings {
  /** One page of a folder or a prefix. */
  list(path: string, cursor?: string): Promise<Listing>;
  /** The front of one file: how it reads, its header, and its first rows. */
  peek(ref: SourceRef): Promise<Peeked>;
}

/**
 * Open is a tab as the panel reads it: a name, something to tell two of them
 * apart by, and the file behind it.
 *
 * A `Tab` is that and a source, a band and a log besides, none of which the
 * panel wants. Taking the smaller shape means a tab is one already, and a test
 * of the workspace section does not have to build a source to have a line.
 */
export interface Open {
  readonly id: string;
  readonly name: string;
  /** Where its file is and what is wrong with it, for a tab that points at one. */
  readonly link?: Link;
  /** How big its file was when it opened. */
  readonly bytes?: number;
  /**
   * The version its bucket holds now, where that is not the one this tab
   * reads: somebody has written the object over since it was opened, or the
   * tab reads a version a save pinned. Asked when the window gets the focus.
   */
  readonly newer?: string;
  /** The files it reads as one, in order, for a tab that is several. */
  readonly parts?: readonly PartInfo[];
}

/**
 * Arriving is a source that was asked for and has not opened yet: a line in
 * the workspace section under the tabs, which says it is on its way and takes
 * no choosing until its tab stands in its place.
 */
export interface Arriving {
  readonly name: string;
  /**
   * Why it never arrived, for a connection that was refused: its line stays,
   * says so, and is chosen to edit the connection and try it again.
   */
  readonly failed?: string;
}

/** What an arriving source's line says beside its name. */
export function opening(): string {
  return m.sources_opening();
}

/** What the line of a connection being tried and kept says beside its name. */
export function connecting(): string {
  return m.sources_connecting();
}

/** What the line of a connection that was refused says beside its name. */
export function failed(): string {
  return m.sources_failed();
}

/**
 * State is what a workspace line says about the file behind a tab: it reads,
 * it is not the file the log was written against, it is not there, it is in a
 * bucket no connection covers and nothing has been read from it, or the
 * bucket holds a newer version than the one it reads.
 */
export type State = "fine" | "changed" | "missing" | "unconnected" | "newer";

/** What a workspace line says beside a tab that is not fine. */
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
 * stateOf is the one state a line says, the most pressing first. Newer comes
 * before changed because it is the one with something to do about it: Reload
 * reads what the bucket holds now.
 */
export function stateOf(tab: Open): State {
  if (tab.link?.connect !== undefined) return "unconnected";
  if (tab.link?.missing !== undefined) return "missing";
  if (tab.newer !== undefined) return "newer";
  if (tab.link?.changed !== undefined) return "changed";
  return "fine";
}

/**
 * Doing is what can be done to the tab the keys are on, besides showing it:
 * read its file again, point it at another, take it out, connect the bucket
 * it reads so that it can be read at all, or append the files its folder has
 * gained since.
 */
export type Doing = "reload" | "repoint" | "remove" | "connect" | "append";

/** One of the things a workspace line offers, as its button says it. */
export interface TabAction {
  label: string;
  does: Doing;
  /** The tab it is done to. */
  id: string;
  /** The files an append adds, in the order they are listed. */
  files?: readonly SingleRef[];
}

/**
 * Joining is how files added as one are read: whether each has a header row,
 * and whether a `_file` column says which file a row came from.
 */
export interface Joining {
  header: HeaderMode;
  fileColumn: boolean;
}

/**
 * Grown is what the folder a tab's files came from has gained: the files in
 * it that sort after the tab's last and are not among its own, which are the
 * ones that can be appended without moving a row.
 */
export interface Grown {
  /** The folder, as a person would say it: shop/2025/. */
  folder: string;
  /** The new files, in the order they are listed. */
  files: readonly SingleRef[];
}

/** newFiles is how many files a folder has gained, in words: "3 new files". */
export function newFiles(n: number): string {
  return m.files_new_count({ count: n });
}

/** fileCount is how many files a tab reads as one, in words: "3 files". */
export function fileCount(n: number): string {
  return m.files_count({ count: n });
}

/**
 * Connection is a place that can be browsed, as its line reads:
 * `acme-exports · s3 · eu-west-1`, `~/exports · disk`.
 *
 * Whoever opens the panel hands these in: the shell reads them off the engine,
 * which keeps them in the connections folder, and turns each into a line with
 * `connectionLine`. What the panel needs of one is a path to ask about.
 */
export interface Connection {
  /** The .unof it was read from, by id. */
  id?: string;
  /** What a person calls it: the bucket, the folder. */
  name: string;
  /** Where browsing it starts: s3://acme-exports, /home/jo/exports. */
  path: string;
  /** The kind of place it is: "s3", "disk". */
  kind: string;
  /** Where that place is, for a kind that is somewhere: "eu-west-1". */
  where?: string;
}

/**
 * connectionLine is a saved connection as the panel lists it: its name, the
 * folder browsing it starts in, and where its bucket is once that is known.
 */
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

/** The sections, in the order they are drawn and moved through. */
export type Section = "workspace" | "connections" | "browser";

export const SECTIONS: readonly Section[] = ["workspace", "connections", "browser"];

/** Where the keys are: which section, and which line in it. */
export interface Place {
  section: Section;
  line: number;
}

/** One step of the breadcrumb: the connection, then each folder entered from it. */
export interface Crumb {
  name: string;
  path: string;
}

/**
 * Button is one of the two under the browser: what it says, and what it hands
 * back.
 *
 * The panel picks the files and puts them in order; opening them is the
 * shell's, since a tab belongs to the workspace and the panel has never held
 * one.
 */
export interface Button {
  /** What it says: "Add 3", "Add as one", "Point ledger.csv here". */
  label: string;
  /** Whether the files are one source between them, or a tab each. */
  one: boolean;
  /** What it hands back: each file in the order they are listed, or the one
   * ref that reads them all in that order. */
  refs: readonly SourceRef[];
  /** The tab the one file is for, when the button re-points rather than adds. */
  to?: string;
}

/**
 * READS is the extensions ingest opens today, which is what a file has to be
 * before a person can pick it.
 *
 * The judgement is here rather than asked of ingest because ingest has no test
 * of a name to ask: `openFormat` reads the extension, then the bytes, and
 * refuses JSON by name, which is an answer that costs a read and arrives long
 * after the line was drawn. A PDF is still listed -- it is in the folder, and
 * a folder that hides what is in it is the worse lie -- and refusing it here
 * is why the button underneath cannot offer to open one. When ingest grows
 * JSON Lines or Parquet, this grows with them.
 */
const READS: readonly string[] = [".csv", ".tsv"];

/**
 * matches is the filter's one rule: the typed text anywhere in the name, with
 * case ignored, since a person looking for a ledger types "ledger" and not
 * "Ledger-2025". Nothing typed matches everything.
 */
function matches(name: string, query: string): boolean {
  return query === "" || name.toLowerCase().includes(query);
}

/**
 * address reads what was searched for as an S3 object, in the s3:// form or
 * one of the https forms a browser shows, the way the + menu reads a pasted
 * URL, and names it after the object as that does.
 *
 * A key ending in a slash is a prefix rather than an object, and there is
 * nothing to add at one, so it is left to be a filter like any other text.
 */
function address(typed: string): SourceRef | undefined {
  const loc = s3Location(typed);
  if (loc === undefined || loc.key.endsWith("/")) return undefined;
  return { name: loc.key.slice(loc.key.lastIndexOf("/") + 1), path: s3Url(loc) };
}

/**
 * trailTo is the crumb down to the folder a file is in, so re-pointing starts
 * where the file was: most often the right one is beside it.
 *
 * An object's trail starts at its bucket, the way a connection's does, and
 * each folder keeps its trailing slash, since that is how the lister names a
 * prefix and a prefix without it is a different one. A file on disk has no
 * connection to start from, so its trail is its folder alone. A path with no
 * folder in it has no trail.
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

/** The characters a file's name is broken into words at. */
const BREAKS = "-_. ";

/**
 * joinedName is what several files added as one are called: what their names
 * share, back to the last whole word of it, with the extension of the first.
 * `orders-2025-01.csv` and `orders-2025-02.csv` are `orders-2025.csv`.
 *
 * The extension stays because the engine picks a reader by it, as it does for
 * one file. Files whose names share no whole word are named after the folder
 * the first is in, and after the first itself where it has none.
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
  // Back to where a word ends in every name, so `ads-q3` and `ads-q4` share
  // `ads` and not `ads-q`.
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
 * folderOf is the folder a file is in, as it is listed and as it is said:
 * s3://acme-exports/shop/2025/ and `shop/2025/`. An object is said by its
 * prefix, which is what a person knows it by, and one at the top of its
 * bucket by the bucket. A file on a disk is said by the folder's own name.
 * Undefined for a path with no folder in it.
 */
function folderOf(path: string): { path: string; said: string } | undefined {
  const last = trailTo(path)?.at(-1);
  if (last === undefined) return undefined;
  const key = s3Location(path)?.key ?? "";
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  return { path: last.path, said: prefix === "" ? `${last.name}/` : prefix };
}

/** A line that exists, for a count of lines that may have changed under it. */
function bound(line: number, count: number): number {
  return Math.max(0, Math.min(line, count - 1));
}

export class Sources {
  private saved: readonly Connection[];
  private found: readonly Entry[] = [];
  private trail: readonly Crumb[] = [];
  private at: Place = { section: "workspace", line: 0 };
  /**
   * Which ask the browser is waiting on, counted rather than named so that
   * leaving a folder and coming back to it are two different asks.
   */
  private asked = 0;
  private waiting = false;
  private refused = "";
  /**
   * Where the next page of the place being browsed starts, as the lister said,
   * or undefined once the last page has landed. A listing is one page however
   * big the prefix is, so this is all that stands between the first page and
   * the rest of a folder of 200,000.
   */
  private cursor: string | undefined;
  /**
   * Whether a later page is on its way. The view asks for more on every scroll
   * event near the end of the list, which is many a second, and this is what
   * makes all but the first of them nothing.
   */
  private paging = false;
  /**
   * The selected files, held as paths and read back through the page, so that
   * what comes out is in listing order however it was picked: *Add as one*
   * takes the files in the order it is handed them, and the order on screen is
   * the only one a person meant by picking them.
   */
  private readonly picks = new Set<string>();
  /** Counts changes to the picks, so the selection kept below knows them by number. */
  private picked = 0;
  /**
   * The selected files as last read, and the page and the picks they were
   * read from. Every draw reads them, through the buttons and the choices,
   * and a page can be 200,000 entries, so they are read once per page and
   * per pick rather than once per draw.
   */
  private selection:
    | { from: readonly Entry[]; picked: number; entries: readonly Entry[] }
    | undefined;
  /**
   * Where each path sits in the page, and the page it was read from. The
   * selection is the picks in the page's order, and this is what puts them in
   * it without reading the page over for every pick; a folder listed again
   * asks it which picks are still there. A later page goes on the end, so
   * `next` carries it on by the page that landed rather than reading it all again.
   */
  private where: { from: readonly Entry[]; at: Map<string, number> } | undefined;
  private shown: Peeked | undefined;
  private looking = false;
  /** Which peek is wanted, counted the way a listing's ask is. */
  private looked = 0;
  /** What the lines are filtered by, lower-cased, or "" for every line. */
  private query = "";
  /** The object an address searched for names, when it named one. */
  private address: SourceRef | undefined;
  /**
   * The entries the filter keeps, and the page they were kept from.
   *
   * A prefix can be 200,000 entries, and every draw and every key reads this
   * list, so it is filtered once per page and per filter rather than once per
   * read. The page is the key because a listing that lands replaces it, and a
   * later page that lands replaces it too: `more` hands `found` a new array
   * rather than pushing onto this one, so the entries kept from it are
   * filtered afresh instead of served short of the page that arrived.
   */
  private kept: { from: readonly Entry[]; query: string; entries: readonly Entry[] } | undefined;
  /**
   * The tab the browser is picking a file for, while it is: re-pointing is
   * browsing with a different button at the end of it.
   */
  private pointing: Open | undefined;
  /** How files added as one are read, as the person last left the choices. */
  private how: Joining = { header: "first", fileColumn: false };
  /**
   * What each tab of several files was last found to be missing from its
   * folder, by the tab's id, and the last part it had when that was asked.
   * An answer for a tab that has been appended to since is about a list of
   * parts that no longer exists, and is not read.
   */
  private readonly gained = new Map<string, { after: string; grown: Grown }>();
  /** The connection being tried and kept, or the one that was refused, while there is one. */
  private trying: Arriving | undefined;

  constructor(
    private readonly listings: Listings,
    /** The open tabs, read at the moment they are drawn rather than copied in:
     * the workspace opens and closes them without telling the panel. */
    private readonly opened: () => readonly Open[],
    connections: readonly Connection[] = [],
    /** Called when a listing lands, so whoever draws can draw it. */
    private readonly changed: () => void = () => {},
    /** The sources being opened, read as they are drawn, the way the tabs are. */
    private readonly arriving: () => readonly Arriving[] = () => [],
  ) {
    this.saved = connections;
  }

  /** In this workspace: one line per open tab the filter keeps. */
  get tabs(): readonly Open[] {
    return this.filtered(this.opened());
  }

  /**
   * The sources still opening that the filter keeps, which are the workspace
   * section's last lines: each is where its tab will be.
   */
  get opening(): readonly Arriving[] {
    return this.filtered(this.arriving());
  }

  /** The places that can be browsed, as far as the filter keeps them. A
   * connection is kept on its path as well, since that is what a person pastes. */
  get connections(): readonly Connection[] {
    return this.filtered(this.saved, (c) => c.path);
  }

  /** filtered is what the filter keeps of a list: everything while it is empty, else what it matches by name, or by `also`. */
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
   * The connection being tried and kept, where the filter keeps it: the line
   * after the connections, which says it is on its way and takes no choosing
   * until it is one of them. Refused, it stays there saying so, until it is
   * edited and kept or given up.
   */
  get connecting(): Arriving | undefined {
    const trying = this.trying;
    if (trying === undefined || this.query === "") return trying;
    return matches(trying.name, this.query) ? trying : undefined;
  }

  /** connect says which connection is being tried and kept, or was refused, or that none is now. */
  connect(trying: Arriving | undefined): void {
    this.trying = trying;
  }

  /** How many lines the connections section has before the one that connects another. */
  private get connected(): number {
    return this.connections.length + (this.connecting === undefined ? 0 : 1);
  }

  /**
   * Whether a connections line is the one after them all, which connects a
   * bucket rather than browsing one. It is a line and not a button in the
   * section's title, so that it is reached the way every other line is: with
   * the keys, and Enter. A search hides it, since a person searching is
   * looking for something that is there, and the section should say whether
   * it is.
   */
  isConnect(line: number): boolean {
    return this.query === "" && line === this.connected;
  }

  /** The browser: the page of the place being browsed, folders first, as far
   * as the filter keeps it. */
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
   * What can be done to the tab the keys are on: reload a tab with a file to
   * read again, re-point one that reads one file, and remove one while it is
   * not the last, since a workspace of none has nothing to show. A tab of
   * several files whose folder has gained more offers to append them, first,
   * since it is the one thing here that is news. Nothing when the keys are
   * not on a tab.
   */
  get doings(): readonly TabAction[] {
    const { section, line } = this.place;
    const tab = section === "workspace" ? this.tabs[line] : undefined;
    if (tab === undefined) return [];
    const id = tab.id;
    const out: TabAction[] = [];
    // A tab in a bucket nobody connected is not reloaded, which would read it
    // with this machine's credentials: it is connected, which is asking.
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
    // Several files read as one are not pointed at another file: the parts
    // are the source, and the one change they take is more at the end.
    if (tab.parts === undefined) out.push({ label: m.action_repoint(), does: "repoint", id });
    if (this.opened().length > 1) out.push({ label: m.action_remove(), does: "remove", id });
    return out;
  }

  /**
   * grown is what the folder a tab's files came from has gained, as the last
   * ask found it, or undefined for a tab with nothing to append.
   */
  grown(tab: Open): Grown | undefined {
    const found = this.gained.get(tab.id);
    return found !== undefined && found.after === tab.parts?.at(-1)?.path ? found.grown : undefined;
  }

  /**
   * askGrown lists the folder each tab of several files came from, and keeps
   * the files in it that sort after the tab's last part and are not among its
   * parts. It is asked when the panel opens and when the window gets the
   * focus back, which is when a folder has had the chance to grow, and the
   * place being browsed is listed again with it.
   *
   * The parts are never read again from the folder: a file landing among
   * them would move every row after it out from under the log. A file after
   * the last moves none, so it is offered, and appending is the person's to
   * choose.
   *
   * A folder that cannot be listed offers nothing and says nothing: the tab
   * reads as it did, and the refusal is worth a sentence where the folder is
   * browsed and not on every focus.
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
   * again lists the place being browsed once more, as far down as it had been
   * read, and shows what it holds now.
   *
   * It is asked whenever askGrown is, for the same reason: a folder that has
   * gained a file offers it on a tab's line, and the browser under that line
   * still listing the folder without it would be the panel saying two things.
   * Nothing is cleared while it is asked, so the lines, the selection and the
   * keys stay where they are, and a folder the person has left or paged
   * further down since is not written over.
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
        // Pushed rather than spread into a new array, which would copy
        // everything read so far once per page: two hundred pages of a
        // prefix are twenty million copies that way.
        for (const entry of page.entries) entries.push(entry);
        cursor = page.next;
        if (entries.length >= was.length) break;
      }
    } catch {
      // What was listed stays, and the refusal is said where the folder is
      // browsed, the next time it is.
      return;
    }
    if (mine !== this.asked || was !== this.found || this.paging) return;
    this.found = entries;
    this.cursor = cursor;
    // A pick the folder no longer holds is let go of, asked of the page's
    // index rather than of every entry per pick: a few picks at the end of a
    // prefix of 200,000 were a second's stall on every focus that way.
    if (this.picks.size > 0) {
      const at = this.index();
      for (const pick of this.picks) if (!at.has(pick)) this.unpick(pick);
    }
    if (this.at.section === "browser") {
      this.at = { section: "browser", line: bound(this.at.line, this.entries.length) };
    }
  }

  /** pages is a folder's listing a page at a time, from the first to the one with no next. */
  private async *pages(path: string): AsyncGenerator<Listing> {
    let cursor: string | undefined;
    do {
      const page = await this.listings.list(path, cursor);
      yield page;
      cursor = page.next;
    } while (cursor !== undefined);
  }

  /** askAfter is askGrown for one tab. */
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
   * The tab the browser is picking a file for, or undefined while it is only
   * browsing. A tab that has closed since is not being picked for any more.
   */
  get repointing(): Open | undefined {
    const p = this.pointing;
    return p !== undefined && this.opened().some((t) => t.id === p.id) ? p : undefined;
  }

  /**
   * repoint starts picking a file for a tab, in the folder its file was in, and
   * puts the keys there. A tab with no path to start from is picked for from
   * wherever the browser already is.
   *
   * Picking for one tab is picking one file, so what was selected to add is let
   * go, and the peek with it.
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

  /** stop is picking done, or given up on: the browser goes back to adding. */
  stop(): void {
    if (this.pointing === undefined) return;
    this.pointing = undefined;
    this.forget();
    this.changed();
  }

  /** What the lines are filtered by, as it was typed less its case. */
  get filter(): string {
    return this.query;
  }

  /**
   * The S3 object the last search was an address of, for the shell to open as
   * a tab. Undefined when what was searched for was only a filter.
   */
  get pasted(): SourceRef | undefined {
    return this.address;
  }

  /**
   * search filters every section by name, and puts the keys on the first line
   * that is left, so Enter straight after a search opens what was searched for.
   *
   * It is a search asked for rather than a filter that follows each key: the
   * three sections are redrawn once per question, not once per letter of it.
   *
   * An object's address is not filtered by. No tab, connection or entry is
   * named s3://bucket/key, so filtering by one would only ever hide every line,
   * and what the person meant was the object. It is read before the case is
   * dropped, since a key is not the same key in another case.
   */
  search(text: string): void {
    this.address = address(text);
    this.query = this.address === undefined ? text.trim().toLowerCase() : "";
    this.at = { section: "workspace", line: 0 };
    if (this.count("workspace") === 0) this.one(1);
  }

  /** Where that place is, from the connection down. Empty until one is opened. */
  get crumb(): readonly Crumb[] {
    return this.trail;
  }

  /** The path being browsed, or "" before a connection has been opened. */
  get path(): string {
    return this.trail[this.trail.length - 1]?.path ?? "";
  }

  /**
   * Whether the first page is on its way, so an ask in flight does not read as
   * an empty folder.
   *
   * It is the first page only. The view says "reading…" when the browser has
   * no lines, and while a later page is coming the folder already has the
   * lines of the pages before it; whether there are more to come is `more`.
   */
  get reading(): boolean {
    return this.waiting;
  }

  /** Whether the place being browsed has a page still to come, for the view to
   * ask for as the list nears its end. */
  get more(): boolean {
    return this.cursor !== undefined;
  }

  /** Why the place being browsed has no entries, when the answer was a refusal
   * rather than a page. */
  get trouble(): string {
    return this.refused;
  }

  /**
   * The files that are selected, in the order they are listed rather than the
   * order they were picked in.
   *
   * Every draw asks, through the buttons, and a page can be 200,000 entries,
   * so with nothing picked it answers without walking the page at all.
   *
   * It reads the whole page rather than what the filter keeps. Filtering is
   * how a person finds the next file in a long prefix, so picking across
   * several searches is how files from all over one are gathered; a pick that
   * a later search hid and quietly dropped would be a file the buttons no
   * longer add, with nothing on screen to say so.
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

  /**
   * index is where each path sits in the page, read once per page: a pick
   * is then a sort of the picks, and not a read of the whole page.
   */
  private index(): ReadonlyMap<string, number> {
    const found = this.found;
    const where = this.where;
    if (where !== undefined && where.from === found) return where.at;
    const at = new Map<string, number>();
    for (let line = 0; line < found.length; line++) at.set(found[line]!.path, line);
    this.where = { from: found, at };
    return at;
  }

  /** Whether an entry is selected, for the line that draws it. */
  chosen(entry: Entry): boolean {
    return this.picks.has(entry.path);
  }

  /**
   * selectable says whether a line can be picked at all. A folder is somewhere
   * to go rather than something to add, and a file no reader opens is refused
   * here so that nothing further down has to.
   */
  selectable(entry: Entry): boolean {
    if (entry.folder) return false;
    const dot = entry.name.lastIndexOf(".");
    return dot > 0 && READS.includes(entry.name.slice(dot).toLowerCase());
  }

  /**
   * The buttons under the browser: none while nothing is selected, "Add 1" for
   * a file on its own, and "Add 3" beside "Add as one" for more than one. One
   * file is one source whichever way it is added, so there is no second thing
   * to offer for it.
   *
   * "Add as one" hands back one ref of every file picked, in the order they
   * are listed, read the way `joining` says.
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
   * How files added as one would be read, while "Add as one" is on offer, and
   * undefined while it is not: the choices are that button's, and are shown
   * with it.
   */
  get joining(): Joining | undefined {
    return this.selected.length > 1 && this.repointing === undefined ? this.how : undefined;
  }

  /**
   * join changes how files added as one are read. The choice stays as it was
   * left for the next files picked, since a person adding one folder of
   * exports with no header row is likely adding another.
   */
  join(how: Partial<Joining>): void {
    this.how = { ...this.how, ...how };
    this.changed();
  }

  /** The front of the one selected file, once it has landed: what is read
   * before anything is added. Nothing while none or several are selected. */
  get peeked(): Peeked | undefined {
    return this.shown;
  }

  /** Whether a peek is on its way, so an ask in flight does not read as a file
   * with nothing in it. */
  get peeking(): boolean {
    return this.looking;
  }

  /**
   * place is bounded as it is read, because two of the three sections are
   * lists the panel does not own: a tab closing is not something it hears
   * about, and the line the keys were on can stop existing between draws.
   */
  get place(): Place {
    return { section: this.at.section, line: bound(this.at.line, this.count(this.at.section)) };
  }

  /** How many lines a section has, which is what moving through it is bounded by. */
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
   * focus puts the keys on a section, at its first line unless another is
   * named. A section with nothing in it can still hold them, so that the keys
   * are somewhere sensible by the time its lines arrive.
   */
  focus(section: Section, line = 0): void {
    this.at = { section, line: bound(line, this.count(section)) };
  }

  /** move walks the keys by lines, down for a positive step and up for a
   * negative one. */
  move(step: number): void {
    for (let i = Math.abs(step); i > 0; i--) this.one(Math.sign(step));
  }

  /**
   * one moves a single line, and carries into the next section when there is
   * no line that way in this one.
   *
   * A section with nothing in it is stepped over rather than landed on: a panel
   * with no connections yet should not swallow an arrow key. Either end of the
   * column holds, since there is nothing past it to show.
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

  /**
   * open browses a connection from its root, and the keys follow it down:
   * choosing a place is asking to see inside it, and leaving the keys on the
   * connections would mean arrowing back through them to reach what arrived.
   */
  async open(connection: Connection): Promise<void> {
    this.trail = [{ name: connection.name, path: connection.path }];
    this.focus("browser");
    await this.browse(connection.path);
  }

  /** enter browses a folder of the place being browsed. */
  async enter(entry: Entry): Promise<void> {
    if (!entry.folder) return;
    this.trail = [...this.trail, { name: entry.name, path: entry.path }];
    await this.browse(entry.path);
  }

  /**
   * up goes back to the folder this one was entered from, and does nothing at
   * the connection, which is as far back as browsing goes: above a bucket is
   * not a folder, and above a folder on disk is somewhere nobody asked to see.
   */
  async up(): Promise<void> {
    if (this.trail.length < 2) return;
    this.trail = this.trail.slice(0, -1);
    await this.browse(this.trail[this.trail.length - 1]!.path);
  }

  /**
   * browse asks for a page and takes it only if it is still the page being
   * looked at.
   *
   * A listing arrives late and the person browsing did not wait for it. An
   * answer for a folder they have already left would land on top of the one
   * they are in, and the entries on screen would be for a path the crumb no
   * longer says, which is a lie the panel has no way to notice afterwards. So
   * every ask is numbered and only the last one is drawn.
   */
  private async browse(path: string): Promise<void> {
    const mine = ++this.asked;
    this.found = [];
    // The page the filter kept from is gone, and holding on to what it kept
    // would keep up to a whole prefix alive for nothing. So would its index.
    this.kept = undefined;
    this.where = undefined;
    this.refused = "";
    this.waiting = true;
    // The cursor was the last folder's, and a page still on its way for that
    // folder is dropped when it lands, so nothing is waited on here any more.
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
      // A place that cannot be reached names itself in the refusal, and the
      // panel has nowhere better to say so than where its entries would be. An
      // empty folder and a bucket this machine has no credentials for look the
      // same otherwise.
      this.refused = said(err);
    }
    this.waiting = false;
    this.changed();
  }

  /**
   * next asks for the page after the ones the place being browsed has, and adds
   * it to the end of them.
   *
   * It does nothing when there is no next page or one is already coming, and
   * sends nothing: the view calls it as the list scrolls near its end, so
   * nearly every call is one of those. A page that lands after the person has
   * browsed somewhere else is dropped by the same count a first page is, since
   * appending it would put one folder's entries under another's crumb.
   *
   * The selection is held by path and the keys by line, and a page is only
   * ever added after the lines already there, so neither moves when it lands.
   */
  async next(): Promise<void> {
    const cursor = this.cursor;
    if (cursor === undefined || this.paging) return;
    const mine = this.asked;
    this.paging = true;

    try {
      const listing = await this.listings.list(this.path, cursor);
      if (mine !== this.asked) return;
      // A new array rather than a push: the filter's cache knows a page by its
      // identity, and would go on serving what it kept before this page came.
      const was = this.found;
      this.found = [...was, ...listing.entries];
      this.carry(was, listing.entries);
      this.cursor = listing.next;
      this.refused = "";
    } catch (err) {
      if (mine !== this.asked) return;
      // The pages that did land are still true of the folder, so they stay,
      // and so does the cursor: the next scroll to the end asks again, which
      // is the retry a person would reach for anyway. The refusal is kept for
      // the view to say where it says why a folder has no lines, which it only
      // needs to when a filter has hidden all of them.
      this.refused = said(err);
    }
    this.paging = false;
    this.changed();
  }

  /**
   * carry brings the index on from the page it was read from to the page with
   * `landed` on the end of it, by the entries that landed and not the whole.
   * Without one there is nothing to carry, and the next pick reads the page.
   */
  private carry(was: readonly Entry[], landed: readonly Entry[]): void {
    const where = this.where;
    if (where === undefined || where.from !== was) return;
    for (let i = 0; i < landed.length; i++) where.at.set(landed[i]!.path, was.length + i);
    this.where = { from: this.found, at: where.at };
  }

  /**
   * toggle puts a file in the selection or takes it out, which is what Space
   * on a browser line does. A line that cannot be picked is left alone rather
   * than complained about: it is drawn like the rest, and Space on it does
   * nothing.
   */
  async toggle(entry: Entry): Promise<void> {
    if (!this.selectable(entry)) return;
    // A tab reads one file, so while picking for one, a pick replaces the last.
    const had = this.picks.has(entry.path);
    if (this.repointing !== undefined) this.picks.clear();
    if (had) this.picks.delete(entry.path);
    else this.picks.add(entry.path);
    this.picked++;
    await this.look();
  }

  /**
   * added lets go of files once they are in the workspace, whether as a tab
   * each or as the parts of one. They are what was picked a moment ago, and
   * left picked they are one Enter from being added twice. Anything picked
   * since stays.
   */
  added(refs: readonly SourceRef[]): void {
    for (const ref of refs) {
      const files = "parts" in ref ? ref.parts.map((part) => part.ref) : [ref];
      for (const file of files) if ("path" in file) this.unpick(file.path);
    }
    void this.look();
  }

  /** unpick takes one file out of the selection, if it was in it. */
  private unpick(path: string): void {
    if (this.picks.delete(path)) this.picked++;
  }

  /**
   * forget drops the selection and whatever was asked for it, which is what
   * browsing somewhere else means: the paths on screen are not the ones that
   * were chosen, and a file picked in the folder just left is not a file this
   * one holds.
   */
  private forget(): void {
    this.picks.clear();
    this.picked++;
    this.shown = undefined;
    this.looking = false;
    this.looked++;
  }

  /**
   * look asks for the front of the one selected file, and takes the answer
   * only if it is still the file that is selected.
   *
   * A person reads down a folder by picking, and each pick outruns the last: a
   * peek of the file above would otherwise land under the name of the file
   * below it, which is the worst lie the panel can tell, since showing it at
   * all is so that the file is chosen by what is in it. So peeks are numbered
   * the way listings are, and only the last one is shown.
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
      // A file that cannot be read has nothing to show, and the panel says
      // nothing of it: adding it is still allowed, and the same failure is
      // worth a sentence where the tab opens rather than twice.
      if (mine !== this.looked) return;
    }
    this.looking = false;
    this.changed();
  }
}
