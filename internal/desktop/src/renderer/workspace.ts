// One open file: what the grid reads, where it came from, and where it goes back to.
//
// A workspace is an engine and the band of rows it sends. The file and the log
// both live in the engine, so view and transform read the same rows the same
// way: transform unlocks editing and turns the recogniser on, and loads
// nothing. An edit is a message and a new generation, which is why applying a
// program to 50 million rows reaches the screen as fast as typing into one cell.
//
// It holds no widgets, which is the property that let the Go build test its
// shell without a window.

import { Band } from "@uno/grid/engine";
import type { Changed, Engine, FindRequest, Found, Offer, SourceRef } from "@uno/grid/engine";
import { NO_ROW, Op, editEquals } from "@uno/grid/sheet";
import type { Edit } from "@uno/grid/sheet";

import type { Rows } from "./grid.ts";

/**
 * The most source a saved workspace embeds. A .uno carries its source inside
 * it, so past this a save is refused by name. Format 4 lifts it by pointing at
 * the file instead.
 */
export const SAVE_LIMIT = 256 << 20;

export type Mode = "view" | "transform";

export class Workspace {
  /** Where a save goes without asking. Empty until the workspace has been saved
   * once, or was opened from a .uno. */
  path = "";

  /** Never saved: every open lands in view. */
  mode: Mode = "view";

  /** The recogniser's question, while it has one. */
  offer: Offer | null = null;

  /** The log as the engine last reported it, and as it was at the last save. */
  private edits: Edit[];
  private savedEdits: Edit[];

  private constructor(
    readonly name: string,
    private readonly engine: Engine,
    private readonly band: Band,
    private readonly label: string,
    edits: Edit[],
  ) {
    this.edits = edits.slice();
    this.savedEdits = edits.slice();
  }

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
  ): Promise<Workspace> {
    const opened = await engine.open(ref);
    const band = new Band(engine, opened, changed);
    const w = new Workspace(opened.name, engine, band, opened.label, opened.edits);
    if (ref.name.toLowerCase().endsWith(".uno")) w.path = savePath;
    return w;
  }

  get rows(): Rows {
    return this.band;
  }

  get editable(): boolean {
    return this.mode === "transform";
  }

  transform(): void {
    this.mode = "transform";
    this.engine.mode(true);
  }

  /** view locks editing again. The log and the dirty dot stay. */
  view(): void {
    this.mode = "view";
    this.offer = null;
    this.engine.mode(false);
  }

  /**
   * set types a value into one cell. It shows at once, the engine records it,
   * and a value the engine refuses is put back.
   */
  async set(row: number, col: number, value: string): Promise<void> {
    const pending = this.band.write(row, col, value);
    try {
      this.landed(await this.engine.edit({ op: Op.Set, row, col, now: value }));
    } catch (err) {
      this.band.restore(pending);
      throw err;
    }
    this.band.settle(pending);
  }

  /** apply runs an offered program over its column: one edit, however long the column. */
  async apply(offer: Offer): Promise<void> {
    this.offer = null;
    this.landed(
      await this.engine.edit({ op: Op.Apply, row: NO_ROW, col: offer.col, now: offer.program }),
    );
  }

  /**
   * undo takes the last edit back and returns it, so the cell it changed can be
   * shown. The engine replays the rest; no row is read again.
   */
  async undo(): Promise<Edit> {
    const changed = await this.engine.undo();
    this.edits.pop();
    this.band.columns = changed.columns;
    return changed.edit;
  }

  /** redo records again the edit undo last took back, and returns it. */
  async redo(): Promise<Edit> {
    const changed = await this.engine.redo();
    this.landed(changed);
    return changed.edit;
  }

  /** find asks the engine for the next matching row in a column, read from the file. */
  find(req: FindRequest): Promise<Found> {
    return this.engine.find(req);
  }

  private landed(changed: Changed): void {
    this.edits.push(changed.edit);
    this.band.columns = changed.columns;
  }

  close(): void {
    this.engine.close();
  }

  /** What a save without a path should suggest. */
  get suggestedFileName(): string {
    const base = this.name.replace(/\.[^.]*$/, "");
    return `${base || "workspace"}.uno`;
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

  /** bytes asks the engine for the workspace as a .uno. */
  bytes(active: { row: number; col: number }): Promise<Uint8Array> {
    return this.engine.save(active, SAVE_LIMIT);
  }

  /** Called once a save has landed, so the workspace stops reading as dirty. */
  saved(path: string): void {
    this.path = path;
    this.savedEdits = this.edits.slice();
  }

  /** How far the index has read the file, as a whole percent. */
  indexed(): number {
    const p = this.engine.progress;
    return p === undefined ? 0 : Math.floor((p.done / Math.max(1, p.total)) * 100);
  }

  /** What the status bar reports about the file itself. */
  status(): string {
    const p = this.engine.progress;
    if (p === undefined) return this.name;

    // Until the index reaches the end, the count is projected from how far it
    // has got, and says so.
    const parts = [
      `${p.complete ? "" : "≈"}${p.rows.toLocaleString()} rows`,
      `${this.band.cols()} columns`,
      this.label,
    ];
    if (!p.complete) parts.push(`indexing ${this.indexed()}%`);

    const edits = this.edits.length;
    if (edits > 0) parts.push(`${edits} ${edits === 1 ? "edit" : "edits"}`);
    return parts.join(" · ");
  }
}
