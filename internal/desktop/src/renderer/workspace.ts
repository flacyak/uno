// One open workspace: its engine, its tabs, which tab is showing, and its
// save state.
//
// Each tab wraps a source handle and the Band of rows the engine sends for
// it. The files and the edit log live in the engine. Transform mode unlocks
// editing and turns the recogniser on. An edit is one message to the engine.
//
// This file is plain logic, so tests run it directly.

import { Band } from "@uno/grid/engine";
import type {
  Changed,
  Engine,
  FindRequest,
  Found,
  Link,
  Offer,
  PartInfo,
  Peeked,
  SourceHandle,
  SourceRef,
} from "@uno/grid/engine";
import { NO_ROW, Op, editEquals } from "@uno/grid/sheet";
import type { Edit } from "@uno/grid/sheet";
import type { Listing, SingleRef } from "@uno/grid/store";

import type { Cell, Rows } from "./grid/rows.ts";
import { m } from "../paraglide/messages.js";
import { bytes } from "./locale.ts";
import { say } from "./said.ts";

/**
 * The most bytes a saved .uno may embed for sources it must carry inline.
 * On the desktop every source has a path, so the embedded total is zero.
 */
export const CARRY_LIMIT = 256 << 20;

export type Mode = "view" | "transform";

/**
 * Returns the status message after a reload, comparing the old tab with the
 * new one: whether the version changed (for a file with a version), whether
 * the size changed, and how many edits were replayed.
 */
export function reloaded(was: Tab, now: Tab): string {
  const before = was.link?.version;
  const after = now.link?.version;
  const sized = was.bytes === now.bytes;
  const moved = { now: bytes(now.bytes), was: bytes(was.bytes) };
  const versioned = before !== undefined && after !== undefined;
  const found = !versioned
    ? sized
      ? m.reload_same_size()
      : m.reload_size_moved(moved)
    : before === after
      ? m.reload_no_change()
      : sized
        ? m.reload_new_version_same_size()
        : m.reload_new_version_size_moved(moved);
  const parts = [m.reloaded_name({ name: now.name }), found];
  if (now.edited > 0) parts.push(m.edits_replayed({ count: now.edited }));
  return parts.join(" · ");
}

/** One source in the workspace. */
export class Tab {
  /** The recogniser's current offer for this source, if any. */
  offer: Offer | null = null;
  /** The selected cell, saved when another tab is shown. */
  cell: Cell = { row: 0, col: 0 };
  /**
   * The version the bucket holds now, when it differs from the one this tab
   * reads. Undefined while the tab reads the newest or is still unchecked.
   */
  newer: string | undefined;

  /** The edit log as last reported by the engine, and as it was at the last save. */
  private edits: Edit[];
  private savedEdits: Edit[];

  constructor(
    readonly source: SourceHandle,
    readonly band: Band,
    /** The saved log carried over from a tab this one replaces. Defaults to
     * the log the source opened with. */
    saved?: readonly Edit[],
  ) {
    this.edits = source.opened.edits.slice();
    this.savedEdits = (saved ?? source.opened.edits).slice();
  }

  get id(): string {
    return this.source.id;
  }

  get name(): string {
    return this.source.opened.name;
  }

  /** The file's size when the source opened. */
  get bytes(): number {
    return this.source.opened.size;
  }

  /** The file behind this source, if it has one. */
  get link(): Link | undefined {
    return this.source.opened.link;
  }

  /** The files read as one source, in order, for a multi-file source. */
  get parts(): readonly PartInfo[] | undefined {
    return this.source.opened.parts;
  }

  /** The missing or changed message for the file, if either applies. */
  get trouble(): string | undefined {
    const wrong = this.link?.missing ?? this.link?.changed;
    return wrong === undefined ? undefined : say(wrong);
  }

  /** Whether the file behind this tab is missing. */
  get missing(): boolean {
    return this.link?.missing !== undefined;
  }

  /** The edit log as of the last save. */
  get savedLog(): readonly Edit[] {
    return this.savedEdits;
  }

  get edited(): number {
    return this.edits.length;
  }

  /**
   * Whether the log differs from the saved log. Compared edit by edit, since
   * undo followed by a different edit keeps the same length.
   */
  get dirty(): boolean {
    const a = this.edits;
    const b = this.savedEdits;
    return a.length !== b.length || !a.every((e, i) => editEquals(e, b[i]!));
  }

  landed(changed: Changed): void {
    this.edits.push(changed.edit);
    this.band.columns = changed.columns;
  }

  undone(changed: Changed): void {
    this.edits.pop();
    this.band.columns = changed.columns;
  }

  saved(): void {
    this.savedEdits = this.edits.slice();
  }
}

export class Workspace {
  /** The path a plain save writes to. Empty until saved once or opened from a .uno. */
  path = "";

  /** The mode is kept in memory only. Every open starts in view. */
  mode: Mode = "view";

  /** Tabs in the order they were added, which is the sidebar order. */
  private tabs: Tab[] = [];
  private showing!: Tab;
  /** The source ids as of the last save. */
  private savedSources: string[] = [];
  /**
   * Ids of sources relinked or appended to since the last save. Both changes
   * leave the log and the source list as they were, so this set is what
   * marks the workspace dirty for them.
   */
  private readonly relinked = new Set<string>();

  private constructor(
    /** The engine this workspace owns. The panel lists and peeks through it. */
    readonly engine: Engine,
    /** Called when rows land or index progress changes. */
    private readonly changed: () => void,
    /** Called when a source's offer changes, with its tab. */
    private readonly offered: (tab: Tab) => void,
  ) {}

  /**
   * Opens a file through the engine and returns the workspace.
   *
   * `savePath` becomes `path` only when the file is a .uno. A dropped .uno
   * passes "" so its first save prompts for a path.
   */
  static async open(
    ref: SourceRef,
    engine: Engine,
    savePath: string,
    changed: () => void,
    offered: (tab: Tab) => void,
  ): Promise<Workspace> {
    const w = new Workspace(engine, changed, offered);
    w.showing = await w.add(ref);
    // The sources it opened with count as saved.
    w.savedSources = w.tabs.map((t) => t.id);
    if (ref.name.toLowerCase().endsWith(".uno")) w.path = savePath;
    return w;
  }

  /**
   * Opens a ref and adds its sources as tabs. Returns the tab to show: the
   * one the engine names, or the first added. The caller decides whether to
   * show it.
   */
  async add(ref: SourceRef): Promise<Tab> {
    const { sources, showing } = await this.engine.open(ref);
    const added = sources.map((s) => this.tab(s));
    this.tabs.push(...added);
    return added.find((t) => t.id === showing) ?? added[0]!;
  }

  private tab(source: SourceHandle, saved?: readonly Edit[]): Tab {
    const t = new Tab(source, new Band(source, this.changed), saved);
    source.onProgress = () => this.changed();
    source.onOffer = (offer) => {
      t.offer = offer;
      this.offered(t);
    };
    return t;
  }

  /**
   * Removes a source from the engine and the tab list. The engine refuses to
   * remove the last source.
   *
   * Returns true if the removed tab was the one showing. In that case the
   * next tab (or the last) is now showing and the grid must redraw.
   */
  async remove(tab: Tab): Promise<boolean> {
    await this.engine.remove(tab.source);
    const i = this.tabs.indexOf(tab);
    if (i < 0) return false;
    this.tabs.splice(i, 1);
    this.relinked.delete(tab.id);
    if (this.showing !== tab) return false;
    this.showing = this.tabs[Math.min(i, this.tabs.length - 1)]!;
    return true;
  }

  /**
   * Points a tab at a different file. The tab is replaced by a new one that
   * keeps its sidebar position, selected cell and saved log.
   */
  async relink(tab: Tab, ref: SourceRef): Promise<Tab> {
    // Only a tab whose file is now found is marked relinked.
    return this.replace(tab, await this.engine.relink(tab.source, ref), (fresh) => !fresh.missing);
  }

  /**
   * Adds files to the end of a multi-file tab. The tab is replaced by a new
   * one that keeps its sidebar position, selected cell, log and saved log.
   */
  async append(tab: Tab, files: readonly SingleRef[]): Promise<Tab> {
    return this.replace(tab, await this.engine.append(tab.source, [...files]), () => true);
  }

  /**
   * Replaces `tab` with a new tab for `source` at the same position, with the
   * same selected cell and saved log. `pointed` decides whether the new tab
   * is marked relinked.
   */
  private replace(tab: Tab, source: SourceHandle, pointed: (fresh: Tab) => boolean): Tab {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return tab;
    const fresh = this.tab(source, tab.savedLog);
    fresh.cell = tab.cell;
    this.tabs[i] = fresh;
    if (pointed(fresh)) this.relinked.add(fresh.id);
    if (this.showing === tab) this.showing = fresh;
    return fresh;
  }

  /** Lists one page of a folder or prefix through the engine. With `peek`,
   * this makes the workspace a `Listings` for the panel. */
  list(path: string, cursor?: string): Promise<Listing> {
    return this.engine.list(path, cursor);
  }

  /** Reads the front of a file through the engine. */
  peek(ref: SourceRef): Promise<Peeked> {
    return this.engine.peek(ref);
  }

  /**
   * Stats each tab whose file has a version and sets `tab.newer` when the
   * bucket now holds a different version. Returns whether any tab's `newer`
   * changed. A failed stat leaves the tab unchanged.
   */
  async askNewer(): Promise<boolean> {
    const remote = this.tabs.filter((t) => t.link?.version !== undefined && !t.missing);
    const now = await Promise.all(
      remote.map((t) =>
        this.engine.stat(t.link!.path).then(
          (entry) => ({ heard: true, version: entry.version }),
          () => ({ heard: false, version: undefined }),
        ),
      ),
    );
    let moved = false;
    remote.forEach((t, i) => {
      const answer = now[i]!;
      if (!answer.heard) return;
      const newer = answer.version !== t.link!.version ? answer.version : undefined;
      if (newer !== t.newer) {
        t.newer = newer;
        moved = true;
      }
    });
    return moved;
  }

  /** The tabs in sidebar order. */
  get sources(): readonly Tab[] {
    return this.tabs;
  }

  /** The tab showing now. */
  get active(): Tab {
    return this.showing;
  }

  /** Makes a tab the showing one, if it belongs to this workspace. */
  show(tab: Tab): void {
    if (this.tabs.includes(tab)) this.showing = tab;
  }

  /** The tab `step` places from the showing one, wrapping at both ends. */
  beside(step: number): Tab {
    const n = this.tabs.length;
    return this.tabs[(((this.tabs.indexOf(this.showing) + step) % n) + n) % n]!;
  }

  get name(): string {
    return this.showing.name;
  }

  get rows(): Rows {
    return this.showing.band;
  }

  /** The showing tab's offer, in transform mode only. */
  get offer(): Offer | null {
    return this.mode === "transform" ? this.showing.offer : null;
  }

  get editable(): boolean {
    return this.mode === "transform";
  }

  transform(): void {
    this.mode = "transform";
    this.engine.mode(true);
  }

  /** Switches to view mode and clears every offer. The log is kept. */
  view(): void {
    this.mode = "view";
    for (const t of this.tabs) t.offer = null;
    this.engine.mode(false);
  }

  /**
   * Sets one cell. The band shows the value at once; if the engine refuses
   * the edit, the band restores the old value and the error is rethrown.
   */
  async set(row: number, col: number, value: string): Promise<void> {
    const t = this.showing;
    const pending = t.band.write(row, col, value);
    try {
      t.landed(await t.source.edit({ op: Op.Set, row, col, now: value }));
    } catch (err) {
      t.band.restore(pending);
      throw err;
    }
    t.band.settle(pending);
  }

  /** Applies an offered program to its column as one edit, and clears the offer. */
  async apply(offer: Offer): Promise<void> {
    const t = this.tabs.find((tab) => tab.id === offer.source);
    if (t === undefined) throw new Error(m.offer_source_gone());
    t.offer = null;
    t.landed(
      await t.source.edit({ op: Op.Apply, row: NO_ROW, col: offer.col, now: offer.program }),
    );
  }

  /**
   * Binds a column to an expression over the row's other columns, as one
   * edit. The engine refuses an expression that fails to parse or names an
   * unknown column.
   */
  async bind(tab: Tab, col: number, expr: string): Promise<void> {
    tab.landed(await tab.source.edit({ op: Op.Bind, row: NO_ROW, col, now: expr }));
  }

  /** Undoes the showing tab's last edit and returns that edit. */
  async undo(): Promise<Edit> {
    const t = this.showing;
    const changed = await t.source.undo();
    t.undone(changed);
    return changed.edit;
  }

  /** Redoes the showing tab's last undone edit and returns it. */
  async redo(): Promise<Edit> {
    const t = this.showing;
    const changed = await t.source.redo();
    t.landed(changed);
    return changed.edit;
  }

  /** Asks the engine for the next matching row in the showing tab. */
  find(req: FindRequest): Promise<Found> {
    return this.showing.source.find(req);
  }

  close(): void {
    this.engine.close();
  }

  /** The file name to suggest in a Save As dialog: the first tab's stem plus .uno. */
  get suggestedFileName(): string {
    const base = (this.tabs[0]?.name ?? "").replace(/\.[^.]*$/, "");
    return `${base || m.workspace_file_stem()}.uno`;
  }

  /** Whether there is unsaved work: an edit, a source added or removed, or
   * a source relinked or appended to. */
  get dirty(): boolean {
    const ids = this.tabs.map((t) => t.id);
    const same =
      ids.length === this.savedSources.length && ids.every((id, i) => id === this.savedSources[i]);
    return !same || this.relinked.size > 0 || this.tabs.some((t) => t.dirty);
  }

  /**
   * Returns the tab whose file, or one of whose parts, is at `path`. Used to
   * refuse saving the workspace over one of its own sources.
   */
  readingFrom(path: string): Tab | undefined {
    return this.tabs.find(
      (t) => t.link?.path === path || t.parts?.some((p) => p.path === path) === true,
    );
  }

  /** Whether a tab has unsaved changes, was relinked, or was added since the last save. */
  unsaved(tab: Tab): boolean {
    return tab.dirty || this.relinked.has(tab.id) || !this.savedSources.includes(tab.id);
  }

  /**
   * Serialises the workspace as a .uno. `cell` is the showing tab's selected
   * cell; other tabs use their saved cell.
   *
   * `at` is the path the file will be written to. The engine writes source
   * paths under the same folder relative to it, so it must be known before
   * serialising.
   */
  bytes(cell: Cell, at: string): Promise<Uint8Array> {
    this.showing.cell = cell;
    return this.engine.save(
      {
        source: this.showing.id,
        cells: this.tabs.map((t) => ({ source: t.id, row: t.cell.row, col: t.cell.col })),
        at,
      },
      CARRY_LIMIT,
    );
  }

  /** Records a completed save: sets the path and resets all dirty state. */
  saved(path: string): void {
    this.path = path;
    this.savedSources = this.tabs.map((t) => t.id);
    this.relinked.clear();
    for (const t of this.tabs) t.saved();
  }

  /** Index progress for the showing tab, as a whole percent. */
  indexed(): number {
    const p = this.showing.source.progress;
    return Math.floor((p.done / Math.max(1, p.total)) * 100);
  }

  /** The status bar text for the showing tab. */
  status(): string {
    const t = this.showing;
    const p = t.source.progress;

    // An unconnected or missing file reports only its trouble.
    if (t.link?.connect !== undefined) return t.trouble ?? "";
    if (t.missing) return `${t.trouble} · ${m.point_at_file_to_see_rows()}`;

    // Until indexing completes, the row count is an estimate and is labelled
    // as one.
    const parts: string[] = [
      p.complete ? m.rows_count({ count: p.rows }) : m.rows_count_about({ count: p.rows }),
      m.columns_count({ count: t.band.cols() }),
    ];
    const read = t.source.opened.label;
    if (read !== undefined) parts.push(say(read));
    if (!p.complete) parts.push(m.indexing_percent({ percent: this.indexed() }));

    const edits = t.edited;
    if (edits > 0) parts.push(m.edits_count({ count: edits }));
    // A newer version takes priority over a changed file, matching the
    // panel's line.
    if (t.newer !== undefined) parts.push(m.newer_version());
    else if (t.link?.changed !== undefined) parts.push(say(t.link.changed));
    return parts.join(" · ");
  }
}
