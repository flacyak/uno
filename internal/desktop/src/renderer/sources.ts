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

import type { Peeked, SourceRef } from "@uno/grid/engine";
import type { Entry, Listing } from "@uno/grid/store";
import { s3Location, s3Url } from "@uno/grid/store/s3";

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
 * Open is a tab as the panel reads it: a name, and something to tell two of
 * them apart by.
 *
 * A `Tab` is that and a source, a band and a log besides, none of which the
 * panel wants. Taking the smaller shape means a tab is one already, and a test
 * of the workspace section does not have to build a source to have a line.
 */
export interface Open {
  readonly id: string;
  readonly name: string;
}

/**
 * Connection is a place that can be browsed, as its line reads:
 * `acme-exports · s3 · eu-west-1`, `~/exports · disk`.
 *
 * Whoever opens the panel hands these in. Where they are kept between sessions
 * is a saved-connection store that does not exist yet, and the panel is none
 * the worse for it: what it needs is a path to ask about.
 */
export interface Connection {
  /** What a person calls it: the bucket, the folder. */
  name: string;
  /** Where browsing it starts: s3://acme-exports, /home/jo/exports. */
  path: string;
  /** The kind of place it is: "s3", "disk". */
  kind: string;
  /** Where that place is, for a kind that is somewhere: "eu-west-1". */
  where?: string;
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
 * Button is one of the two under the browser: what it says, and the files it
 * hands back.
 *
 * The panel picks the files and puts them in order; opening them is the
 * shell's, since a tab belongs to the workspace and the panel has never held
 * one.
 */
export interface Button {
  /** What it says: "Add 3", "Add as one". */
  label: string;
  /** Whether the files are one source between them, or a tab each. */
  one: boolean;
  /** The files it hands back, in the order they are listed. */
  refs: readonly SourceRef[];
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

  constructor(
    private readonly listings: Listings,
    /** The open tabs, read at the moment they are drawn rather than copied in:
     * the workspace opens and closes them without telling the panel. */
    private readonly opened: () => readonly Open[],
    connections: readonly Connection[] = [],
    /** Called when a listing lands, so whoever draws can draw it. */
    private readonly changed: () => void = () => {},
  ) {
    this.saved = connections;
  }

  /** In this workspace: one line per open tab the filter keeps. */
  get tabs(): readonly Open[] {
    const q = this.query;
    const all = this.opened();
    return q === "" ? all : all.filter((t) => matches(t.name, q));
  }

  /** The places that can be browsed, as far as the filter keeps them. A
   * connection is kept on its path as well, since that is what a person pastes. */
  get connections(): readonly Connection[] {
    const q = this.query;
    return q === ""
      ? this.saved
      : this.saved.filter((c) => matches(c.name, q) || matches(c.path, q));
  }

  set connections(list: readonly Connection[]) {
    this.saved = list;
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
    return this.found.filter((e) => this.picks.has(e.path));
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
   */
  get buttons(): readonly Button[] {
    const refs = this.selected.map((e) => ({ name: e.name, path: e.path }));
    if (refs.length === 0) return [];
    const each: Button = { label: `Add ${refs.length}`, one: false, refs };
    if (refs.length === 1) return [each];
    return [each, { label: "Add as one", one: true, refs }];
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
        return this.tabs.length;
      case "connections":
        return this.connections.length;
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
    // would keep up to a whole prefix alive for nothing.
    this.kept = undefined;
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
      this.refused = err instanceof Error ? err.message : String(err);
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
      this.found = [...this.found, ...listing.entries];
      this.cursor = listing.next;
      this.refused = "";
    } catch (err) {
      if (mine !== this.asked) return;
      // The pages that did land are still true of the folder, so they stay,
      // and so does the cursor: the next scroll to the end asks again, which
      // is the retry a person would reach for anyway. The refusal is kept for
      // the view to say where it says why a folder has no lines, which it only
      // needs to when a filter has hidden all of them.
      this.refused = err instanceof Error ? err.message : String(err);
    }
    this.paging = false;
    this.changed();
  }

  /**
   * toggle puts a file in the selection or takes it out, which is what Space
   * on a browser line does. A line that cannot be picked is left alone rather
   * than complained about: it is drawn like the rest, and Space on it does
   * nothing.
   */
  async toggle(entry: Entry): Promise<void> {
    if (!this.selectable(entry)) return;
    if (!this.picks.delete(entry.path)) this.picks.add(entry.path);
    await this.look();
  }

  /**
   * forget drops the selection and whatever was asked for it, which is what
   * browsing somewhere else means: the paths on screen are not the ones that
   * were chosen, and a file picked in the folder just left is not a file this
   * one holds.
   */
  private forget(): void {
    this.picks.clear();
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
