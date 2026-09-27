// The panel beside the grid: what is open, the places files come from, and the
// one being browsed now.
//
// The three sections are one column of lines, which is what lets a person work
// the panel without a mouse: the keys are always in a section and on a line in
// it, and moving off the end of one carries into the next.
//
// It holds no widgets, for the reason the workspace holds none. Browsing is
// where the mistakes are -- a listing that lands after the person has moved on,
// a crumb that says one place while the entries are another -- and all of it is
// tested here without a window.

import type { Entry, Listing } from "@uno/grid/store";

/**
 * Listings is the whole of what the panel needs an engine for.
 *
 * `Engine.list` is one without being told so, which is the point: a test
 * browses a stand-in that answers out of a map, and the panel never holds an
 * engine it could reach further into. It is narrower than store's `Lister` as
 * well, since which lister claims a path is the engine's business and the panel
 * only ever has a path and asks.
 */
export interface Listings {
  /** One page of a folder or a prefix. */
  list(path: string, cursor?: string): Promise<Listing>;
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

const SECTIONS: readonly Section[] = ["workspace", "connections", "browser"];

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

  /** In this workspace: one line per open tab. */
  get tabs(): readonly Open[] {
    return this.opened();
  }

  /** The places that can be browsed. */
  get connections(): readonly Connection[] {
    return this.saved;
  }

  set connections(list: readonly Connection[]) {
    this.saved = list;
  }

  /** The browser: the page of the place being browsed, folders first. */
  get entries(): readonly Entry[] {
    return this.found;
  }

  /** Where that place is, from the connection down. Empty until one is opened. */
  get crumb(): readonly Crumb[] {
    return this.trail;
  }

  /** The path being browsed, or "" before a connection has been opened. */
  get path(): string {
    return this.trail[this.trail.length - 1]?.path ?? "";
  }

  /** Whether a page is on its way, so an ask in flight does not read as an
   * empty folder. */
  get reading(): boolean {
    return this.waiting;
  }

  /** Why the place being browsed has no entries, when the answer was a refusal
   * rather than a page. */
  get trouble(): string {
    return this.refused;
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
        return this.opened().length;
      case "connections":
        return this.saved.length;
      case "browser":
        return this.found.length;
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
    this.refused = "";
    this.waiting = true;
    if (this.at.section === "browser") this.at = { section: "browser", line: 0 };
    this.changed();

    try {
      const listing = await this.listings.list(path);
      if (mine !== this.asked) return;
      this.found = listing.entries;
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
}
