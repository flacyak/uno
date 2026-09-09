// One open file: the sheet, what it was made from, and where it goes back to.
//
// This is `internal/ui/workspace.go` with the Fyne taken out. It holds no
// widgets and does no I/O, so the whole of it can be exercised without a window
// -- which is the property that let the Go build test its shell the same way.

import { newManifest, readDocument, writeDocument } from "@uno/grid/document";
import type { Document } from "@uno/grid/document";
import { read as ingest } from "@uno/grid/ingest";
import type { Sheet } from "@uno/grid/sheet";

export class Workspace {
  /** Where a save goes without asking. Empty until the workspace has been saved
   * once, or was opened from a .uno. */
  path = "";

  private readonly doc: Document;

  private constructor(doc: Document) {
    this.doc = doc;
  }

  /**
   * fromFile decides what it was handed by the extension, then by the bytes.
   *
   * A .uno is a container to unpack; anything else is a spreadsheet to ingest.
   * Either way the result is a sheet plus the raw bytes it came from, because a
   * workspace is those bytes and the log of what was done to them.
   */
  static fromFile(name: string, path: string, bytes: Uint8Array): Workspace {
    if (name.toLowerCase().endsWith(".uno")) {
      const doc = readDocument(name, bytes);
      const w = new Workspace(doc);
      w.path = path;
      return w;
    }

    const sheet = ingest(name, bytes);
    const w = new Workspace({
      manifest: newManifest(name),
      raw: bytes,
      state: { active: { row: 0, col: 0 } },
      edits: [],
      extra: new Map(),
      sheet,
    });
    // A CSV has no .uno to go back to, so the first save has to ask where.
    w.path = "";
    return w;
  }

  get sheet(): Sheet {
    return this.doc.sheet!;
  }

  /** What the tab and the window title say. */
  get name(): string {
    return this.doc.manifest.source.name;
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
    return !this.sheet.logEquals(this.doc.edits);
  }

  /**
   * bytes renders the workspace as a .uno.
   *
   * The manifest is filled in with the three things the writer cannot see for
   * itself -- where the bytes came from, the shape the log builds, and where the
   * person was -- and everything else it measures from what it writes.
   */
  bytes(active: { row: number; col: number }): Uint8Array {
    this.doc.edits = this.sheet.edits();
    this.doc.manifest.sheet.rows = this.sheet.rows();
    this.doc.manifest.sheet.cols = this.sheet.cols();
    this.doc.state.active = active;
    return writeDocument(this.doc);
  }

  /** Called once a save has landed, so the workspace stops reading as dirty. */
  saved(path: string): void {
    this.path = path;
    this.doc.edits = this.sheet.edits();
  }

  /** What the status bar reports about the file itself. */
  status(): string {
    const parts = [
      `${this.sheet.rows().toLocaleString()} rows`,
      `${this.sheet.cols()} columns`,
      this.sheet.source,
    ].filter((p) => p !== "");

    const edits = this.sheet.editCount();
    if (edits > 0) parts.push(`${edits} ${edits === 1 ? "edit" : "edits"}`);
    return parts.join(" · ");
  }
}
