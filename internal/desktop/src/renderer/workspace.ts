// One open workspace: its sources, which one is showing, and where it goes back to.
//
// A workspace is an engine and, for each source in it, the band of rows it
// sends. The files and the log live in the engine, so view and transform read
// the same rows the same way: transform unlocks editing and turns the
// recogniser on, and loads nothing. An edit is a message and a new generation,
// which is why applying a program to 50 million rows reaches the screen as fast
// as typing into one cell.
//
// It holds no widgets, which is the property that let the Go build test its
// shell without a window.

import { Band } from "@uno/grid/engine";
import type {
  Changed,
  Engine,
  FindRequest,
  Found,
  Offer,
  SourceHandle,
  SourceRef,
} from "@uno/grid/engine";
import { NO_ROW, Op, editEquals } from "@uno/grid/sheet";
import type { Edit } from "@uno/grid/sheet";

import type { Cell, Rows } from "./grid/rows.ts";

/**
 * The most source a saved workspace embeds, all its sources together. A .uno
 * carries its sources inside it, so past this a save is refused by name.
 * Pointing at the files instead lifts it.
 */
export const SAVE_LIMIT = 256 << 20;

export type Mode = "view" | "transform";

/** One source as the workspace shows it: a tab. */
export class Tab {
  /** The recogniser's question about this source, while it has one. */
  offer: Offer | null = null;
  /** Where the selection was when another tab was shown, so coming back finds it. */
  cell: Cell = { row: 0, col: 0 };

  /** The log as the engine last reported it, and as it was at the last save. */
  private edits: Edit[];
  private savedEdits: Edit[];

  constructor(
    readonly source: SourceHandle,
    readonly band: Band,
  ) {
    this.edits = source.opened.edits.slice();
    this.savedEdits = source.opened.edits.slice();
  }

  get id(): string {
    return this.source.id;
  }

  get name(): string {
    return this.source.opened.name;
  }

  get edited(): number {
    return this.edits.length;
  }

  /**
   * dirty compares the log rather than counting it.
   *
   * Undo makes a count ambiguous: taking one edit back and making a different
   * one lands on the same number and a different sheet.
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
  /** Where a save goes without asking. Empty until the workspace has been saved
   * once, or was opened from a .uno. */
  path = "";

  /** Never saved: every open lands in view. */
  mode: Mode = "view";

  /** In the order they were added, which is the order the strip shows. */
  private tabs: Tab[] = [];
  private showing!: Tab;
  /** The sources the last save held, so adding or removing one is unsaved work too. */
  private savedSources: string[] = [];

  private constructor(
    private readonly engine: Engine,
    /** Called when rows land or the index moves, so whoever draws can draw them. */
    private readonly changed: () => void,
    /** Called when a source's offer changes, with the tab it belongs to. */
    private readonly offered: (tab: Tab) => void,
  ) {}

  /**
   * open reads a file through an engine the workspace owns from here on.
   *
   * `savePath` is where Ctrl+S writes without asking. It only applies to a .uno,
   * since anything else has no workspace file to go back to, and a dropped .uno
   * passes "" so its first save asks.
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
    // What it opened with is nothing to lose: the file is still where it was.
    // A source added after it is, until a save keeps it.
    w.savedSources = w.tabs.map((t) => t.id);
    if (ref.name.toLowerCase().endsWith(".uno")) w.path = savePath;
    return w;
  }

  /**
   * add puts a file's sources in the workspace, and returns the one to show:
   * the file just added, or the source a .uno was left on. What shows stays
   * the caller's decision, since the grid has to follow it.
   */
  async add(ref: SourceRef): Promise<Tab> {
    const { sources, showing } = await this.engine.open(ref);
    const added = sources.map((s) => this.tab(s));
    this.tabs.push(...added);
    return added.find((t) => t.id === showing) ?? added[0]!;
  }

  private tab(source: SourceHandle): Tab {
    const t = new Tab(source, new Band(source, this.changed));
    source.onProgress = () => this.changed();
    source.onOffer = (offer) => {
      t.offer = offer;
      this.offered(t);
    };
    return t;
  }

  /**
   * remove takes a source out, and its edits out of the log. The engine keeps
   * the last one, since a workspace of none has nothing to show or save.
   */
  async remove(tab: Tab): Promise<void> {
    await this.engine.remove(tab.source);
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.showing === tab) this.showing = this.tabs[Math.min(i, this.tabs.length - 1)]!;
  }

  /** The sources, in the order the strip shows them. */
  get sources(): readonly Tab[] {
    return this.tabs;
  }

  /** The tab showing now. */
  get active(): Tab {
    return this.showing;
  }

  /** show makes another tab the one the grid draws and every edit goes to. */
  show(tab: Tab): void {
    if (this.tabs.includes(tab)) this.showing = tab;
  }

  /** The tab `step` places along from the one showing, wrapping at either end. */
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

  /** The recogniser's question about the source showing. */
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

  /** view locks editing again. The log and the dirty dots stay. */
  view(): void {
    this.mode = "view";
    for (const t of this.tabs) t.offer = null;
    this.engine.mode(false);
  }

  /**
   * set types a value into one cell. It shows at once, the engine records it,
   * and a value the engine refuses is put back.
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

  /** apply runs an offered program over its column: one edit, however long the column. */
  async apply(offer: Offer): Promise<void> {
    const t = this.tabs.find((tab) => tab.id === offer.source);
    if (t === undefined) throw new Error("the source that offer was about is gone");
    t.offer = null;
    t.landed(
      await t.source.edit({ op: Op.Apply, row: NO_ROW, col: offer.col, now: offer.program }),
    );
  }

  /**
   * undo takes the showing source's last edit back and returns it, so the cell
   * it changed can be shown. The engine replays the rest; no row is read again.
   */
  async undo(): Promise<Edit> {
    const t = this.showing;
    const changed = await t.source.undo();
    t.undone(changed);
    return changed.edit;
  }

  /** redo records again the edit undo last took back, and returns it. */
  async redo(): Promise<Edit> {
    const t = this.showing;
    const changed = await t.source.redo();
    t.landed(changed);
    return changed.edit;
  }

  /** find asks the engine for the next matching row in a column, read from the file. */
  find(req: FindRequest): Promise<Found> {
    return this.showing.source.find(req);
  }

  close(): void {
    this.engine.close();
  }

  /** What a save without a path should suggest: named after the first source. */
  get suggestedFileName(): string {
    const base = (this.tabs[0]?.name ?? "").replace(/\.[^.]*$/, "");
    return `${base || "workspace"}.uno`;
  }

  /** Whether anything would be lost by closing: an edit, or a source added or removed. */
  get dirty(): boolean {
    const ids = this.tabs.map((t) => t.id);
    const same =
      ids.length === this.savedSources.length && ids.every((id, i) => id === this.savedSources[i]);
    return !same || this.tabs.some((t) => t.dirty);
  }

  /** Whether a tab holds something the last save did not. */
  unsaved(tab: Tab): boolean {
    return tab.dirty || !this.savedSources.includes(tab.id);
  }

  /**
   * bytes asks the engine for the workspace as a .uno. `cell` is where the
   * grid is on the tab showing; every other tab is where it was left.
   */
  bytes(cell: Cell): Promise<Uint8Array> {
    this.showing.cell = cell;
    return this.engine.save(
      {
        source: this.showing.id,
        cells: this.tabs.map((t) => ({ source: t.id, row: t.cell.row, col: t.cell.col })),
      },
      SAVE_LIMIT,
    );
  }

  /** Called once a save has landed, so the workspace stops reading as dirty. */
  saved(path: string): void {
    this.path = path;
    this.savedSources = this.tabs.map((t) => t.id);
    for (const t of this.tabs) t.saved();
  }

  /** How far the index has read the showing file, as a whole percent. */
  indexed(): number {
    const p = this.showing.source.progress;
    return Math.floor((p.done / Math.max(1, p.total)) * 100);
  }

  /** What the status bar reports about the file showing. */
  status(): string {
    const t = this.showing;
    const p = t.source.progress;

    // Until the index reaches the end, the count is projected from how far it
    // has got, and says so.
    const parts = [
      `${p.complete ? "" : "≈"}${p.rows.toLocaleString()} rows`,
      `${t.band.cols()} columns`,
      t.source.opened.label,
    ];
    if (!p.complete) parts.push(`indexing ${this.indexed()}%`);

    const edits = t.edited;
    if (edits > 0) parts.push(`${edits} ${edits === 1 ? "edit" : "edits"}`);
    return parts.join(" · ");
  }
}
