// The workspace an engine owns: its sources, one View each, and the order the
// log was made in across them.
//
// A View knows one file and its own edits. What only the workspace knows is
// which source each line of the log changed, in the order the lines were
// written, because that order is what a person reads back and what a save
// writes. Everything that changes the log runs here one at a time, so a save
// always pairs each source's edits with the order they were made in.
//
// A saved workspace points at its files rather than copying them, so opening one
// is opening every file it names, and one of them may be gone. That source comes
// back as an Absent: no grid, but its id, its edits, its place in the log and its
// path are all still here, and `relink` turns it back into a View. Losing a path
// must not cost the work done through it.

import { logOf, newManifest, readContainer, sourceId, writeDocument } from "../document/index.ts";
import type { Document, Held, Logged, State } from "../document/index.ts";
import type { Edit } from "../sheet/index.ts";
import { bytesSource } from "../store/index.ts";
import type {
  Opening,
  Changed,
  EditRequest,
  FindRequest,
  Found,
  Link,
  Opened,
  Place,
  Port,
  Reply,
  Request,
  SourceRef,
} from "./protocol.ts";
import { formatBytes, messageOf } from "./protocol.ts";
import type { Tuning } from "./rows.ts";
import { View } from "./view.ts";
import type { Carried, OpenSource, Part } from "./view.ts";

/**
 * The largest .uno read whole.
 *
 * It bounds the container and not the data in it. A workspace that points at
 * five 4 GB exports is a few kilobytes of JSON, and nothing under this ceiling
 * is a file anybody meant to make by hand.
 */
export const WHOLE_LIMIT = 256 << 20;

/**
 * Absent is a source the workspace could not open: the file it pointed at has
 * moved, or been deleted, or will not parse.
 *
 * It holds everything about the source except its rows -- the id the log names,
 * the edits made through it, the path that used to work, the state the .uno left
 * it in -- so a save writes it back exactly as it was found. A workspace that
 * dropped a source it could not read would quietly throw away somebody's
 * afternoon on the next Ctrl+S.
 */
class Absent {
  readonly opened: Opened;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly path: string,
    /**
     * The bytes the container carried, for a source that had no path and would
     * not parse. They go back in at the next save: uno could not read them, but
     * that is not a reason to be the thing that finally loses them.
     */
    private readonly raw: Uint8Array | undefined,
    /** What the file measured when the workspace was saved. */
    readonly bytes: number,
    private readonly edits: Edit[],
    private readonly rows: number,
    private readonly cols: number,
    why: string,
  ) {
    this.opened = {
      source: id,
      name,
      size: bytes,
      label: "",
      columns: [],
      // Complete, because nothing is going to arrive. A grid that waits for rows
      // out of a file that is not there waits forever, and says "indexing 0%"
      // the whole time.
      progress: { done: 0, total: bytes, readable: 0, rows: 0, complete: true },
      edits,
      generation: 0,
      link: { path, missing: why },
    };
  }

  /** Whatever the container carried for it, which for a pointed-at source is
   * nothing. */
  get carries(): number {
    return this.raw?.length ?? 0;
  }

  /** What a save writes: the pointer or the bytes it was given, and the log,
   * all exactly as they were read. */
  part(): Promise<Part> {
    return Promise.resolve({
      raw: this.raw,
      path: this.path === "" ? undefined : this.path,
      bytes: this.bytes,
      edits: this.edits,
      rows: this.rows,
      cols: this.cols,
    });
  }

  /** The log as it stands, which is what a relink replays over the file it is
   * pointed at. */
  get log(): Edit[] {
    return this.edits;
  }

  /** Nothing to switch, and nothing to close. */
  mode(_transform: boolean): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A source in the workspace, whether or not there is a file behind it. */
type Source = View | Absent;

export class Workspace {
  /** In the order the workspace shows them, which is the order they were added. */
  private readonly sources = new Map<string, Source>();

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
      const id = sourceId(ref.name, this.sources.keys());
      const view = await this.view(id, ref, undefined);
      return { opened: [this.keep(view)], showing: id };
    });
  }

  /**
   * remove takes a source out of the workspace, and its edits out of the log.
   * The last source stays: a workspace of none has nothing to show or save.
   */
  remove(id: string): Promise<void> {
    return this.serially(async () => {
      const source = this.need(id);
      if (this.sources.size === 1) {
        throw new Error(`${source.name} is the only source here, and a workspace needs one`);
      }
      this.sources.delete(id);
      this.states.delete(id);
      this.trail = this.trail.filter((s) => s !== id);
      await source.close();
    });
  }

  /**
   * relink points a source at a file: one whose file has gone, or one whose
   * file has changed under the log.
   *
   * The id stays, which is what keeps the log attached to it, and the edits are
   * replayed over what the file holds now. A file that will not take them --
   * because it is a quarter the size and the log names a row past its end --
   * leaves the source as it was and says so, so a wrong pick costs nothing.
   */
  relink(id: string, ref: SourceRef): Promise<Opened> {
    return this.serially(async () => {
      const was = this.need(id);
      const carried: Carried = { container: "", edits: was.log };
      const view = await this.view(id, ref, carried);

      // Only once the new one is open, so a refused relink leaves the source
      // showing whatever it was showing before.
      this.sources.set(id, view);
      if (this.transform) view.mode(true);
      await was.close();
      return view.opened;
    });
  }

  /** A .uno's sources: each opened from the file it points at, or carried. */
  private async openWorkspace(ref: SourceRef): Promise<Opening> {
    if (this.sources.size > 0) {
      throw new Error(`${ref.name} is a workspace of its own · open it rather than adding it`);
    }

    // A .uno is a zip, and whatever it carries has to come out of it before
    // anything can index it. It was written from memory, so it is read into
    // memory -- which is what the ceiling is for, and why a pointed-at source
    // costs the container nothing.
    const at = "path" in ref ? ref.path : "";
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
    const doc = readContainer(ref.name, bytes, at);

    for (const src of doc.sources) {
      this.keep(await this.reopen(ref.name, src, logOf(doc.log, src.id)));
      this.states.set(src.id, src.state);
    }

    this.trail = doc.log.map((l) => l.source);
    this.created = doc.manifest.created;
    this.extra = doc.extra;
    return { opened: [...this.sources.values()].map((v) => v.opened), showing: doc.active };
  }

  /**
   * reopen builds one source of a .uno back: from the file it points at, or
   * from the bytes it carried.
   *
   * A source that will not open is an Absent rather than a failed open of the
   * whole workspace. Refusing all of it over one moved CSV would leave a person
   * with a file full of their own work and no way into it.
   */
  private async reopen(container: string, src: Held, edits: Edit[]): Promise<Source> {
    const carried: Carried = { container, raw: src.raw, edits };
    try {
      const view =
        src.raw === undefined
          ? await this.view(src.id, { name: src.name, path: src.path ?? "" }, carried)
          : await View.open(
              src.id,
              src.name,
              "",
              bytesSource(src.raw),
              carried,
              this.port,
              this.tuning,
            );
      view.opened.link = linkOf(view, src);
      return view;
    } catch (err) {
      return new Absent(
        src.id,
        src.name,
        src.path ?? "",
        src.raw,
        src.bytes ?? 0,
        edits,
        src.rows,
        src.cols,
        messageOf(err),
      );
    }
  }

  /** view opens one file as a source, through whatever this platform hands back
   * for a SourceRef. A ref with no path is bytes a save will have to carry. */
  private async view(id: string, ref: SourceRef, carried: Carried | undefined): Promise<View> {
    const path = "path" in ref ? ref.path : "";
    const source = await this.openSource(ref);
    return View.open(id, ref.name, path, source, carried, this.port, this.tuning);
  }

  private keep(source: Source): Opened {
    this.sources.set(source.id, source);
    if (this.transform) source.mode(true);
    return source.opened;
  }

  /** drop closes every source, for a workspace that is going away. */
  private async drop(): Promise<void> {
    const sources = [...this.sources.values()];
    this.sources.clear();
    this.states.clear();
    this.trail = [];
    await Promise.all(sources.map((v) => v.close()));
  }

  // ------------------------------------------------------------ reading

  rows(
    id: string,
    first: number,
    count: number,
  ): Promise<{ generation: number; rows: string[][]; raws: Array<string[] | null> }> {
    return this.needView(id).rows(first, count);
  }

  find(id: string, req: FindRequest): Promise<Found> {
    return this.needView(id).find(req);
  }

  // ------------------------------------------------------------ changing

  /** mode switches every source between view and transform, and any added later. */
  mode(transform: boolean): void {
    this.transform = transform;
    for (const source of this.sources.values()) source.mode(transform);
  }

  edit(id: string, req: EditRequest): Promise<Changed> {
    return this.serially(async () => {
      const changed = await this.needView(id).edit(req);
      this.trail.push(id);
      return changed;
    });
  }

  /** undo takes back the source's last edit, wherever it sits in the workspace's log. */
  undo(id: string): Promise<Changed> {
    return this.serially(async () => {
      const changed = await this.needView(id).undo();
      this.trail.splice(this.trail.lastIndexOf(id), 1);
      return changed;
    });
  }

  redo(id: string): Promise<Changed> {
    return this.serially(async () => {
      const changed = await this.needView(id).redo();
      this.trail.push(id);
      return changed;
    });
  }

  // ------------------------------------------------------------ saving

  /**
   * save writes the workspace as a .uno: where each source's file is, the bytes
   * of any source there is no file for, and the log in the order it was made.
   *
   * A source uno can name by path is pointed at, so the size of the data has
   * nothing to do with the size of the save. `limit` bounds what is left --
   * bytes with no file behind them, which a container has to carry or lose.
   */
  save(place: Place, limit: number): Promise<Uint8Array> {
    return this.serially(async () => {
      const sources = [...this.sources.values()];
      if (sources.length === 0) throw new Error("no file is open");
      this.refuseOver(sources, limit);

      const parts = new Map<string, Part>();
      for (const source of sources) parts.set(source.id, await source.part());

      const cells = new Map(place.cells.map((c) => [c.source, { row: c.row, col: c.col }]));
      const held = sources.map((source): Held => {
        const part = parts.get(source.id)!;
        const kept = this.states.get(source.id);
        const state: State = {
          ...kept,
          active: cells.get(source.id) ?? kept?.active ?? { row: 0, col: 0 },
        };
        return {
          id: source.id,
          name: source.name,
          raw: part.raw,
          path: part.path,
          bytes: part.bytes,
          rows: part.rows,
          cols: part.cols,
          state,
        };
      });

      const doc: Document = {
        manifest: { ...newManifest(), created: this.created },
        sources: held,
        active: this.sources.has(place.source) ? place.source : sources[0]!.id,
        log: interleave(this.trail, parts),
        extra: this.extra,
        at: place.at,
      };
      const bytes = writeDocument(doc);
      this.created = doc.manifest.created;
      for (const src of held) this.states.set(src.id, src.state);
      return bytes;
    });
  }

  /**
   * refuseOver stops a save that would have to carry more bytes than a container
   * should hold.
   *
   * Only a source with no file behind it counts: bytes dropped into a browser
   * tab, which uno has nothing to point at and so must copy or lose. Everything
   * opened from a path is a path in the manifest and weighs nothing.
   */
  private refuseOver(sources: Source[], limit: number): void {
    const carried = sources.filter((s) => s.carries > 0);
    const total = carried.reduce((sum, s) => sum + s.carries, 0);
    if (total <= limit) return;
    if (carried.length === 1) {
      const s = carried[0]!;
      throw new Error(
        `${s.name} is ${formatBytes(s.carries)}, over the ${formatBytes(limit)} a workspace can carry for a source it has no file to point at`,
      );
    }
    throw new Error(
      `the ${carried.length} sources with no file behind them come to ${formatBytes(total)}, over the ${formatBytes(limit)} a workspace can carry`,
    );
  }

  // ------------------------------------------------------------ lifetime

  async close(): Promise<void> {
    this.closed = true;
    await this.drop();
  }

  private need(id: string): Source {
    if (this.closed) throw new Error("the workspace was closed");
    const source = this.sources.get(id);
    if (source === undefined) {
      const none = this.sources.size === 0;
      throw new Error(none ? "no file is open" : `no source called ${id} is open`);
    }
    return source;
  }

  /** needView is `need` for the requests that read or change rows, which an
   * Absent has none of. */
  private needView(id: string): View {
    const source = this.need(id);
    if (!(source instanceof View)) {
      throw new Error(`${source.name} has no file behind it · point it at one to read its rows`);
    }
    return source;
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * linkOf is what the client is told about the file behind a source it just
 * reopened.
 *
 * A size that does not match the one in the manifest is the only check worth
 * running at open: it is free, and it catches the export that was written again
 * since. What it cannot tell is whether the rows moved, so it is reported and
 * nothing is refused over it. The log still replays, and a person looking at the
 * grid is better placed than uno to say whether it is the right file.
 */
function linkOf(view: View, src: Held): Link | undefined {
  if (view.path === "") return undefined;
  const was = src.bytes ?? 0;
  if (was === 0 || was === view.size) return { path: view.path };
  return {
    path: view.path,
    changed: `${src.name} is ${formatBytes(view.size)} now and was ${formatBytes(was)} when the workspace was saved`,
  };
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
