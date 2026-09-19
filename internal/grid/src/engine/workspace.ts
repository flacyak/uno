// The workspace an engine owns: its sources, one View each, and the order the
// log was made in across them.
//
// A View knows one file and its own edits. What only the workspace knows is
// which source each line of the log changed, in the order the lines were
// written, because that order is what a person reads back and what a save
// writes. Everything that changes the log runs here one at a time, so a save
// always pairs each source's edits with the order they were made in.

import { logOf, newManifest, readContainer, sourceId, writeDocument } from "../document/index.ts";
import type { Document, Embedded, Logged, State } from "../document/index.ts";
import { bytesSource } from "../store/index.ts";
import type {
  Opening,
  Changed,
  EditRequest,
  FindRequest,
  Found,
  Opened,
  Place,
  Port,
  Reply,
  Request,
  SourceRef,
} from "./protocol.ts";
import { formatBytes } from "./protocol.ts";
import type { Tuning } from "./rows.ts";
import { View } from "./view.ts";
import type { OpenSource, Part } from "./view.ts";

/**
 * The largest .uno read whole. It is the same ceiling saving embeds sources
 * under, so any file this build wrote opens again.
 */
export const WHOLE_LIMIT = 256 << 20;

export class Workspace {
  /** In the order the workspace shows them, which is the order they were added. */
  private readonly views = new Map<string, View>();

  /**
   * Which source each line of the log changed, oldest first. The edits
   * themselves are in each View; this is how they interleave.
   */
  private trail: string[] = [];

  /** When the .uno this came from was first saved. Undefined until the first save. */
  private created: Date | undefined;
  /** What a .uno held that this build did not recognise, kept for the next save. */
  private extra = new Map<string, Uint8Array>();
  /** Each source's state as a .uno left it, so what a save does not replace survives it. */
  private readonly states = new Map<string, State>();

  private transform = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly openSource: OpenSource,
    private readonly port: Port<Request, Reply>,
    private readonly tuning: Tuning,
  ) {}

  // ------------------------------------------------------------ sources

  /**
   * open adds a file to the workspace and answers with what it opened.
   *
   * A .uno is a workspace of its own, so it opens every source it holds, and
   * only into an engine that holds none. Anything else is one more source,
   * named after its file.
   */
  open(ref: SourceRef): Promise<Opening> {
    return this.serially(async () => {
      if (ref.name.toLowerCase().endsWith(".uno")) return this.openWorkspace(ref);
      const id = sourceId(ref.name, this.views.keys());
      const view = await View.open(
        id,
        ref.name,
        await this.openSource(ref),
        undefined,
        this.port,
        this.tuning,
      );
      return { opened: [this.keep(view)], showing: id };
    });
  }

  /**
   * remove takes a source out of the workspace, and its edits out of the log.
   * The last source stays: a workspace of none has nothing to show or save.
   */
  remove(id: string): Promise<void> {
    return this.serially(async () => {
      const view = this.need(id);
      if (this.views.size === 1) {
        throw new Error(`${view.name} is the only source here, and a workspace needs one`);
      }
      this.views.delete(id);
      this.states.delete(id);
      this.trail = this.trail.filter((s) => s !== id);
      await view.close();
    });
  }

  /** A .uno's sources, each with its part of the log applied. */
  private async openWorkspace(ref: SourceRef): Promise<Opening> {
    if (this.views.size > 0) {
      throw new Error(`${ref.name} is a workspace of its own · open it rather than adding it`);
    }

    // A .uno is a zip, and its sources have to come out of it before anything
    // can index them. It was written from memory, so it is read into memory.
    const file = await this.openSource(ref);
    let bytes: Uint8Array;
    try {
      if (file.size > WHOLE_LIMIT) {
        throw new Error(
          `${ref.name} is ${formatBytes(file.size)}, over the ${formatBytes(WHOLE_LIMIT)} a workspace can be read whole`,
        );
      }
      bytes = await file.read(0, file.size);
    } finally {
      await file.close();
    }
    const doc = readContainer(ref.name, bytes);

    try {
      for (const src of doc.sources) {
        const carried = { container: ref.name, raw: src.raw, edits: logOf(doc.log, src.id) };
        const view = await View.open(
          src.id,
          src.name,
          bytesSource(src.raw),
          carried,
          this.port,
          this.tuning,
        );
        this.keep(view);
        this.states.set(src.id, src.state);
      }
    } catch (err) {
      // All of it or none: a workspace missing one of its sources would save
      // without it.
      await this.drop();
      throw err;
    }

    this.trail = doc.log.map((l) => l.source);
    this.created = doc.manifest.created;
    this.extra = doc.extra;
    return { opened: [...this.views.values()].map((v) => v.opened), showing: doc.active };
  }

  private keep(view: View): Opened {
    this.views.set(view.id, view);
    if (this.transform) view.mode(true);
    return view.opened;
  }

  /** drop closes every source, for an open that could not finish. */
  private async drop(): Promise<void> {
    const views = [...this.views.values()];
    this.views.clear();
    this.states.clear();
    this.trail = [];
    await Promise.all(views.map((v) => v.close()));
  }

  // ------------------------------------------------------------ reading

  rows(
    id: string,
    first: number,
    count: number,
  ): Promise<{ generation: number; rows: string[][]; raws: Array<string[] | null> }> {
    return this.need(id).rows(first, count);
  }

  find(id: string, req: FindRequest): Promise<Found> {
    return this.need(id).find(req);
  }

  // ------------------------------------------------------------ changing

  /** mode switches every source between view and transform, and any added later. */
  mode(transform: boolean): void {
    this.transform = transform;
    for (const view of this.views.values()) view.mode(transform);
  }

  edit(id: string, req: EditRequest): Promise<Changed> {
    return this.serially(async () => {
      const changed = await this.need(id).edit(req);
      this.trail.push(id);
      return changed;
    });
  }

  /** undo takes back the source's last edit, wherever it sits in the workspace's log. */
  undo(id: string): Promise<Changed> {
    return this.serially(async () => {
      const changed = await this.need(id).undo();
      this.trail.splice(this.trail.lastIndexOf(id), 1);
      return changed;
    });
  }

  redo(id: string): Promise<Changed> {
    return this.serially(async () => {
      const changed = await this.need(id).redo();
      this.trail.push(id);
      return changed;
    });
  }

  // ------------------------------------------------------------ saving

  /**
   * save writes the workspace as a .uno: every source, embedded, and the log
   * in the order it was made.
   *
   * Embedding is the only layout this build writes, so sources over `limit`
   * together are refused by name. Pointing at the files instead lifts that.
   */
  save(place: Place, limit: number): Promise<Uint8Array> {
    return this.serially(async () => {
      const views = [...this.views.values()];
      if (views.length === 0) throw new Error("no file is open");
      this.refuseOver(views, limit);

      const parts = new Map<string, Part>();
      for (const view of views) parts.set(view.id, await view.part());

      const cells = new Map(place.cells.map((c) => [c.source, { row: c.row, col: c.col }]));
      const sources = views.map((view): Embedded => {
        const part = parts.get(view.id)!;
        const kept = this.states.get(view.id);
        const state: State = {
          ...kept,
          active: cells.get(view.id) ?? kept?.active ?? { row: 0, col: 0 },
        };
        return {
          id: view.id,
          name: view.name,
          raw: part.raw,
          rows: part.rows,
          cols: part.cols,
          state,
        };
      });

      const doc: Document = {
        manifest: { ...newManifest(), created: this.created },
        sources,
        active: this.views.has(place.source) ? place.source : views[0]!.id,
        log: interleave(this.trail, parts),
        extra: this.extra,
      };
      const bytes = writeDocument(doc);
      this.created = doc.manifest.created;
      for (const src of sources) this.states.set(src.id, src.state);
      return bytes;
    });
  }

  private refuseOver(views: View[], limit: number): void {
    const total = views.reduce((sum, v) => sum + v.size, 0);
    if (total <= limit) return;
    const until = "until it can point at the file instead";
    if (views.length === 1) {
      const v = views[0]!;
      throw new Error(
        `${v.name} is ${formatBytes(v.size)}, and a .uno can carry ${formatBytes(limit)} of its source ${until}`,
      );
    }
    throw new Error(
      `the ${views.length} sources come to ${formatBytes(total)}, and a .uno can carry ${formatBytes(limit)} of them ${until}`,
    );
  }

  // ------------------------------------------------------------ lifetime

  async close(): Promise<void> {
    this.closed = true;
    await this.drop();
  }

  private need(id: string): View {
    if (this.closed) throw new Error("the workspace was closed");
    const view = this.views.get(id);
    if (view === undefined) {
      throw new Error(this.views.size === 0 ? "no file is open" : `no source called ${id} is open`);
    }
    return view;
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * interleave lays each source's edits out in the order the trail says they
 * were made. A trail and a set of logs that disagree would write a file whose
 * log says something different from what the person did, so that is an error
 * rather than a best effort.
 */
function interleave(trail: readonly string[], parts: ReadonlyMap<string, Part>): Logged[] {
  const next = new Map<string, number>();
  const log: Logged[] = trail.map((source) => {
    const i = next.get(source) ?? 0;
    const edit = parts.get(source)?.edits[i];
    if (edit === undefined) throw new Error(`the log lost track of an edit to ${source}`);
    next.set(source, i + 1);
    return { source, edit };
  });
  for (const [source, part] of parts) {
    if ((next.get(source) ?? 0) !== part.edits.length) {
      throw new Error(`the log lost track of an edit to ${source}`);
    }
  }
  return log;
}
