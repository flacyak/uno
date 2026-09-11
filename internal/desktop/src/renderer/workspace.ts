// One open file: what the grid reads, where it came from, and where it goes back to.
//
// A workspace opens in view. Its rows come from an engine that owns the file,
// and the renderer keeps a band of them around the viewport, so opening costs
// the same for 4,812 rows and for 200 million. Transform loads the file into a
// Sheet, which is the only thing that takes an edit today. That load has a
// ceiling, so a file too large for it stays in view and says why.
//
// It holds no widgets, which is the property that let the Go build test its
// shell without a window.

import { newManifest, readDocument, writeDocument } from "@uno/grid/document";
import type { Document } from "@uno/grid/document";
import { Band, formatBytes } from "@uno/grid/engine";
import type { Engine, SourceRef } from "@uno/grid/engine";
import { read as ingest } from "@uno/grid/ingest";
import type { Sheet } from "@uno/grid/sheet";

import type { Rows } from "./grid.ts";

/**
 * The largest file transform will load. A Sheet keeps every cell as a string,
 * and near 400,000 rows that stops fitting in a renderer's heap. This is well
 * under that. It goes away once transform reads through the engine the way
 * view does.
 */
export const TRANSFORM_LIMIT = 64 << 20;

export type Mode = "view" | "transform";

export class Workspace {
  /** Where a save goes without asking. Empty until the workspace has been saved
   * once, or was opened from a .uno. */
  path = "";

  /** Never saved: every open lands in view. */
  mode: Mode = "view";

  private doc: Document | undefined;
  private band: Band | undefined;
  private label = "";
  private size = 0;

  private constructor(
    private readonly ref: SourceRef,
    private engine: Engine | undefined,
  ) {}

  /**
   * open reads a file through an engine that the workspace owns from here on.
   *
   * A .uno is read whole: its rows are the source with the log replayed, and
   * the engine cannot replay a log yet. It lands in view over the replayed
   * sheet. Anything else is viewed through the engine, and nothing of it is
   * loaded.
   *
   * `savePath` is where Ctrl+S writes without asking. A dropped .uno passes ""
   * so its first save asks.
   */
  static async open(
    ref: SourceRef,
    engine: Engine,
    savePath: string,
    changed: () => void,
  ): Promise<Workspace> {
    const w = new Workspace(ref, engine);

    if (ref.name.toLowerCase().endsWith(".uno")) {
      w.doc = readDocument(ref.name, await engine.bytes(ref, TRANSFORM_LIMIT));
      w.path = savePath;
      w.release();
      return w;
    }

    const opened = await engine.open(ref);
    w.band = new Band(engine, opened, changed);
    w.label = opened.label;
    w.size = opened.size;
    return w;
  }

  /** What the grid draws: the sheet once there is one, the band until then. */
  get rows(): Rows {
    return this.doc?.sheet ?? this.band!;
  }

  /** The sheet, once transform has loaded one. */
  get sheet(): Sheet | undefined {
    return this.doc?.sheet;
  }

  get editable(): boolean {
    return this.mode === "transform";
  }

  /**
   * transform loads the file into a sheet the first time, then unlocks editing.
   *
   * The engine goes once the sheet exists, since everything it served is now in
   * memory. Leaving transform keeps the sheet and its log; it only locks editing.
   */
  async transform(): Promise<void> {
    if (this.doc === undefined) {
      if (this.size > TRANSFORM_LIMIT) {
        throw new Error(
          `${this.name} is ${formatBytes(this.size)}, and transform can load ${formatBytes(TRANSFORM_LIMIT)} at most for now. It stays in view`,
        );
      }
      if (this.engine === undefined) throw new Error(`${this.name} is no longer open`);

      const raw = await this.engine.bytes(this.ref, TRANSFORM_LIMIT);
      this.doc = {
        manifest: newManifest(this.ref.name),
        raw,
        state: { active: { row: 0, col: 0 } },
        edits: [],
        extra: new Map(),
        sheet: ingest(this.ref.name, raw),
      };
      this.release();
    }
    this.mode = "transform";
  }

  view(): void {
    this.mode = "view";
  }

  /** close lets the engine go, and the utility process behind it. */
  close(): void {
    this.release();
  }

  private release(): void {
    this.engine?.close();
    this.engine = undefined;
    this.band = undefined;
  }

  /** What the tab and the window title say. */
  get name(): string {
    return this.doc?.manifest.source.name ?? this.ref.name;
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
    return this.doc !== undefined && !this.doc.sheet!.logEquals(this.doc.edits);
  }

  /**
   * bytes renders the workspace as a .uno.
   *
   * The manifest is filled in with the three things the writer cannot see for
   * itself -- where the bytes came from, the shape the log builds, and where the
   * person was -- and everything else it measures from what it writes.
   */
  bytes(active: { row: number; col: number }): Uint8Array {
    const doc = this.doc;
    if (doc === undefined)
      throw new Error("nothing to save until the file is in transform · Ctrl+E");
    const sheet = doc.sheet!;
    doc.edits = sheet.edits();
    doc.manifest.sheet.rows = sheet.rows();
    doc.manifest.sheet.cols = sheet.cols();
    doc.state.active = active;
    return writeDocument(doc);
  }

  /** Called once a save has landed, so the workspace stops reading as dirty. */
  saved(path: string): void {
    this.path = path;
    if (this.doc !== undefined) this.doc.edits = this.doc.sheet!.edits();
  }

  /** What the status bar reports about the file itself. */
  status(): string {
    const sheet = this.doc?.sheet;
    if (sheet !== undefined) {
      const parts = [
        `${sheet.rows().toLocaleString()} rows`,
        `${sheet.cols()} columns`,
        sheet.source,
      ].filter((p) => p !== "");
      const edits = sheet.editCount();
      if (edits > 0) parts.push(`${edits} ${edits === 1 ? "edit" : "edits"}`);
      return parts.join(" · ");
    }

    const p = this.engine?.progress;
    if (this.band === undefined || p === undefined) return this.name;

    // Until the index reaches the end, the count is projected from how far it
    // has got, and says so.
    const parts = [
      `${p.complete ? "" : "≈"}${p.rows.toLocaleString()} rows`,
      `${this.band.cols()} columns`,
      this.label,
    ];
    if (!p.complete) parts.push(`indexing ${Math.floor((p.done / Math.max(1, p.total)) * 100)}%`);
    return parts.join(" · ");
  }
}
