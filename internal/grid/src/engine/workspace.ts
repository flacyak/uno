// The workspace an engine owns: its sources, one View each, and the order
// edits were made across them.
//
// Each View holds its own edits. The workspace holds the trail: which source
// each edit changed, in order. Everything that changes the log runs through
// one queue.
//
// A source from a .uno that fails to open becomes an Absent. It keeps its
// id, edits, place in the log and path, and `relink` turns it back into a
// View.

import {
  isAbsolute,
  logOf,
  newManifest,
  readContainer,
  samePath,
  sourceId,
  writeDocument,
} from "../document/index.ts";
import type { Document, Held, HeldParts, Logged, State } from "../document/index.ts";
import type { Edit } from "../sheet/index.ts";
import { bytesSource, multiOf, openWith, partMap } from "../store/index.ts";
import type { ByteSource, FileHandler, PartsRef, SingleRef } from "../store/index.ts";
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
import { Refusal, saidOf } from "../said/index.ts";
import type { Said } from "../said/index.ts";
import type { Meeting, Unconnected } from "../store/s3.ts";
import type { Tuning } from "./rows.ts";
import { unmeasured } from "./telemetry.ts";
import type { Telemetry } from "./telemetry.ts";
import { View } from "./view.ts";
import type { Carried, Part } from "./view.ts";

/**
 * The largest .uno file read whole. It bounds the container file itself.
 */
export const WHOLE_LIMIT = 256 << 20;

/**
 * Absent is a source whose open failed: its file moved, was deleted or
 * fails to parse, or one of its parts did.
 *
 * It holds everything about the source except its rows, so a save writes it
 * back exactly as it was read.
 */
class Absent {
  readonly opened: Opened;

  constructor(
    readonly id: string,
    readonly name: string,
    /** What a save writes of it, exactly as the .uno held it. */
    private readonly kept: Part,
    why: Said,
    /** The uncovered bucket it reads, when that is why it is absent. */
    connect?: Unconnected,
  ) {
    const path = this.path;
    const size = sizeOf(kept);
    this.opened = {
      source: id,
      name,
      size,
      columns: [],
      // Marked complete so the grid settles with zero rows.
      progress: { done: 0, total: size, readable: 0, rows: 0, complete: true },
      edits: kept.edits,
      generation: 0,
      link: connect === undefined ? { path, missing: why } : { path, missing: why, connect },
    };
  }

  /** The file's path, or "" for a carried source or one over several files. */
  get path(): string {
    return this.kept.path ?? "";
  }

  /** The parts ref for a source over several files, built from what the .uno
   * saved. */
  get parts(): PartsRef | undefined {
    const kept = this.kept;
    return kept.parts === undefined ? undefined : joinedFrom({ ...kept, name: this.name });
  }

  /** The size of the carried bytes, or 0 for a pointed-at source. */
  get carries(): number {
    return this.kept.raw?.length ?? 0;
  }

  /** Returns what the .uno held, unchanged. */
  part(): Promise<Part> {
    return Promise.resolve(this.kept);
  }

  /** The edit log. */
  get log(): Edit[] {
    return this.kept.edits;
  }

  /** The bucket it waits on being connected, if that is why it is absent. */
  get waiting(): Unconnected | undefined {
    return this.opened.link?.connect;
  }

  /**
   * missing returns the same source with a new reason and its bucket wait
   * cleared.
   */
  missing(why: Said): Absent {
    return new Absent(this.id, this.name, this.kept, why);
  }

  mode(_transform: boolean): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A source in the workspace: a View over its rows, or an Absent. */
type Source = View | Absent;

export class Workspace {
  /** Sources in display order, which is the order they were added. */
  private readonly sources = new Map<string, Source>();

  /**
   * Which source each edit in the log changed, oldest first. The edits
   * themselves are in each View.
   */
  private trail: string[] = [];

  /** When the .uno was first saved. Undefined until the first save. */
  private created: Date | undefined;
  /** Entries of the .uno unknown to this build, kept for the next save. */
  private extra = new Map<string, Uint8Array>();
  /** Each source's saved state from the .uno, carried into the next save. */
  private readonly states = new Map<string, State>();

  private transform = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    /** The handlers this engine can open files through. */
    private readonly handlers: readonly FileHandler[],
    private readonly port: Port<Request, Reply>,
    private readonly tuning: Tuning,
    /**
     * Returns which connection an address is read through, or the uncovered
     * bucket it sits in. Returns undefined for a local address. Undefined on
     * a platform that keeps only local files.
     */
    private readonly meet?: (path: string) => Meeting | undefined,
    /** Receives how long each source took to index. */
    private readonly telemetry: Telemetry = unmeasured,
  ) {}

  /** openSource opens a ref through whichever handler claims it. */
  private openSource(ref: SourceRef): Promise<ByteSource> {
    return openWith(this.handlers, ref);
  }

  // ------------------------------------------------------------ sources

  /**
   * open adds a file to the workspace and returns what it opened. A .uno
   * opens every source it holds, and only into an empty workspace.
   */
  open(ref: SourceRef): Promise<Opening> {
    return this.serially(async () => {
      // A parts ref is always a source, whatever its name.
      const workspace = !("parts" in ref) && ref.name.toLowerCase().endsWith(".uno");
      if (workspace) return this.openWorkspace(ref);
      const id = sourceId(ref.name, this.sources.keys());
      const view = await this.view(id, ref, undefined);
      return { opened: [this.keep(view)], showing: id };
    });
  }

  /**
   * remove takes a source out of the workspace, and its edits out of the
   * log. Removing the last source is refused.
   */
  remove(id: string): Promise<void> {
    return this.serially(async () => {
      const source = this.need(id);
      if (this.sources.size === 1) {
        throw new Refusal({ t: "only-source", name: source.name });
      }
      this.sources.delete(id);
      this.states.delete(id);
      this.trail = this.trail.filter((s) => s !== id);
      await source.close();
    });
  }

  /**
   * relink points a source at a different file. The id stays, and the edits
   * are replayed over the new file. A failed open leaves the source as it
   * was and throws.
   *
   * One exception: a source that was waiting for its bucket to be connected,
   * relinked to the same addresses now that they are covered, becomes a
   * plain Absent with the failure as its reason, and relink returns it.
   *
   * A source over several files is relinked part for part. Each part is
   * held to the extent the save recorded, and every part is opened before
   * the source is swapped.
   */
  relink(id: string, ref: SourceRef): Promise<Opened> {
    return this.serially(async () => {
      const was = this.need(id);
      const to = pointedTo(was, ref);
      const carried: Carried = { container: "", edits: was.log };
      let view: View;
      try {
        view = await this.view(id, to, carried, "parts" in to);
      } catch (err) {
        const places = pathsIn(to);
        const connected =
          was instanceof Absent &&
          was.waiting !== undefined &&
          places.length > 0 &&
          sameList(places, pathsIn(was.parts ?? { name: was.name, path: was.path })) &&
          places.every((path) => this.unconnected(path) === undefined);
        if (!connected) throw err;
        const now = was.missing(saidOf(err));
        this.sources.set(id, now);
        return now.opened;
      }

      // Swapped only after the new view is open, so a failed relink leaves
      // the old source in place.
      return this.replace(was, view);
    });
  }

  /**
   * append adds files at the end of a source over several files. Existing
   * parts keep their places, so every row keeps its number and the log is
   * replayed unchanged. A file already in the source, or given twice, is
   * refused. A failed append leaves the source as it was.
   */
  append(id: string, files: readonly SingleRef[]): Promise<Opened> {
    return this.serially(async () => {
      const was = this.need(id);
      if (!(was instanceof View)) {
        throw new Refusal({ t: "append-to-absent", name: was.name });
      }
      const ref = was.extended(files);
      if (ref === undefined) {
        throw new Refusal({ t: "append-to-one-file", name: was.name });
      }
      if (files.length === 0) throw new Refusal({ t: "append-nothing", name: was.name });
      const had = ref.parts.length - files.length;
      files.forEach((file, i) => {
        if (!("path" in file)) return;
        const at = ref.parts.findIndex((part) => "path" in part.ref && part.ref.path === file.path);
        if (at < had) {
          throw new Refusal({
            t: "append-already-part",
            file: file.name,
            part: at + 1,
            name: was.name,
          });
        }
        if (at < had + i) throw new Refusal({ t: "append-twice", file: file.name, name: was.name });
      });

      const view = await this.view(id, ref, { container: "", edits: was.log });

      // Swapped only after the new view is open, so a failed append leaves
      // the old source in place.
      return this.replace(was, view);
    });
  }

  /** openWorkspace opens every source of a .uno, each from its file or its carried bytes. */
  private async openWorkspace(ref: SourceRef): Promise<Opening> {
    if (this.sources.size > 0) {
      throw new Refusal({ t: "workspace-as-source", name: ref.name });
    }

    // The .uno is read whole into memory, up to WHOLE_LIMIT.
    const at = "path" in ref ? ref.path : "";
    const file = await this.openSource(ref);
    let bytes: Uint8Array;
    try {
      if (file.size > WHOLE_LIMIT) {
        throw new Refusal({
          t: "workspace-too-large",
          name: ref.name,
          bytes: file.size,
          limit: WHOLE_LIMIT,
        });
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
   * reopen opens one source of a .uno from its file, its parts, or its
   * carried bytes. A source that fails to open becomes an Absent, and the
   * rest of the workspace opens.
   *
   * Parts open lazily. Each is opened by the first read that
   * reaches it and held to the extent the save recorded.
   */
  private async reopen(container: string, src: Held, edits: Edit[]): Promise<Source> {
    // What a save writes back of it, exactly as the .uno held it.
    const kept: Part = { ...src, edits };
    // A source in an uncovered bucket skips the read. It becomes an Absent
    // that waits for the bucket to be connected.
    const needs = this.unconnectedIn(src);
    if (needs !== undefined) {
      return new Absent(
        src.id,
        src.name,
        kept,
        { t: "bucket-unconnected", container, bucket: needs.bucket },
        needs,
      );
    }
    const carried: Carried = { container, raw: src.raw, edits };
    try {
      const view =
        src.parts !== undefined
          ? await this.view(src.id, joinedFrom(src), carried)
          : src.raw === undefined
            ? // By path, pinned to the saved version where there is one.
              await this.view(src.id, fileAt(src.name, src.path ?? "", src.version), carried)
            : await View.open(
                src.id,
                src.name,
                "",
                bytesSource(src.raw),
                carried,
                this.port,
                this.tuning,
                this.telemetry,
              );
      view.opened.link = linkOf(view, src);
      return view;
    } catch (err) {
      return new Absent(src.id, src.name, kept, saidOf(err));
    }
  }

  /** unconnected returns the uncovered bucket an address is in, if any. */
  private unconnected(path: string): Unconnected | undefined {
    const met = this.meet?.(path);
    return met !== undefined && "unconnected" in met ? met.unconnected : undefined;
  }

  /**
   * unconnectedIn returns the first uncovered bucket among the addresses a
   * .uno source reads, if any.
   */
  private unconnectedIn(src: Held): Unconnected | undefined {
    for (const path of pathsOf(src)) {
      const needs = this.unconnected(path);
      if (needs !== undefined) return needs;
    }
    return undefined;
  }

  /**
   * through returns the id of the connection a ref is read through, saved
   * as a hint. For several files it is the one connection all bucket parts
   * share, or undefined if they use more than one.
   */
  private through(ref: SourceRef): string | undefined {
    const files = "parts" in ref ? ref.parts.map((part) => part.ref) : [ref];
    const ids = new Set<string>();
    for (const file of files) {
      const met = "path" in file ? this.meet?.(file.path) : undefined;
      if (met !== undefined && "through" in met) ids.add(met.through);
    }
    const [id] = ids;
    return ids.size === 1 ? id : undefined;
  }

  /** view opens a ref as a View. With `whole`, every part of a source over
   * several files is opened first, so a missing part fails here by name. */
  private async view(
    id: string,
    ref: SourceRef,
    carried: Carried | undefined,
    whole = false,
  ): Promise<View> {
    const path = "path" in ref ? ref.path : "";
    const source = await this.openSource(ref);
    // versions() opens every part still unread. A part that fails to open
    // closes the source and is the error.
    if (whole) {
      await multiOf(source)
        ?.versions()
        .catch(async (err: unknown) => {
          await source.close();
          throw err;
        });
    }
    const view = await View.open(
      id,
      ref.name,
      path,
      source,
      carried,
      this.port,
      this.tuning,
      this.telemetry,
      // A parts ref carries its own header mode. A single file has a header row.
      "parts" in ref ? ref.header : "first",
      "parts" in ref ? ref : undefined,
    );
    view.connection = this.through(ref);
    if ("parts" in ref) {
      view.opened.parts = ref.parts.map((part) => ({
        name: part.ref.name,
        path: "path" in part.ref ? part.ref.path : "",
      }));
    }
    return view;
  }

  private keep(source: Source): Opened {
    this.sources.set(source.id, source);
    if (this.transform) source.mode(true);
    return source.opened;
  }

  /** replace puts `now` under `was`'s id and closes `was`. */
  private async replace(was: Source, now: View): Promise<Opened> {
    const opened = this.keep(now);
    await was.close();
    return opened;
  }

  /** drop removes and closes every source. */
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

  /** mode switches every source, and any added later, between view and transform. */
  mode(transform: boolean): void {
    this.transform = transform;
    for (const source of this.sources.values()) source.mode(transform);
  }

  edit(id: string, req: EditRequest): Promise<Changed> {
    return this.changing(id, (view) => view.edit(req), "push");
  }

  /** undo takes back the source's last edit and removes its last mention from the trail. */
  undo(id: string): Promise<Changed> {
    return this.changing(id, (view) => view.undo(), "pull");
  }

  redo(id: string): Promise<Changed> {
    return this.changing(id, (view) => view.redo(), "push");
  }

  /**
   * changing runs one change to a source's log in the queue and updates the
   * trail: "push" appends the source, "pull" removes its last mention.
   */
  private changing(
    id: string,
    change: (view: View) => Promise<Changed>,
    trail: "push" | "pull",
  ): Promise<Changed> {
    return this.serially(async () => {
      const changed = await change(this.needView(id));
      if (trail === "push") this.trail.push(id);
      else this.trail.splice(this.trail.lastIndexOf(id), 1);
      return changed;
    });
  }

  // ------------------------------------------------------------ saving

  /**
   * save writes the workspace as a .uno: each source's path or carried
   * bytes, and the log in the order it was made. `limit` bounds the total
   * carried bytes.
   */
  save(place: Place, limit: number): Promise<Uint8Array> {
    return this.serially(async () => {
      const sources = [...this.sources.values()];
      if (sources.length === 0) throw new Refusal({ t: "no-file-open" });
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
        return { ...part, id: source.id, name: source.name, state };
      });
      this.refuseWhere(held, place.at);

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
   * refuseOver throws if the carried sources total more than `limit` bytes.
   * Only carried sources count.
   */
  private refuseOver(sources: Source[], limit: number): void {
    const carried = sources.filter((s) => s.carries > 0);
    const total = carried.reduce((sum, s) => sum + s.carries, 0);
    if (total <= limit) return;
    if (carried.length === 1) {
      const s = carried[0]!;
      throw new Refusal({ t: "carried-too-large", name: s.name, bytes: s.carries, limit });
    }
    throw new Refusal({
      t: "carried-together-too-large",
      count: carried.length,
      bytes: total,
      limit,
    });
  }

  /**
   * refuseWhere throws if any source path is relative, or if the .uno would
   * be written over a file the workspace reads.
   */
  private refuseWhere(held: readonly Held[], at: string): void {
    for (const src of held) {
      for (const path of pathsOf(src)) {
        if (!isAbsolute(path)) {
          throw new Refusal({
            t: "text",
            text: `${src.name} was opened by ${path}, which is relative to nowhere a workspace can point from · open it by its full path`,
          });
        }
        if (at !== "" && samePath(path, at)) {
          throw new Refusal({
            t: "text",
            text: `${at} is where ${src.name} is read from · saving the workspace there would write over it`,
          });
        }
      }
    }
  }

  // ------------------------------------------------------------ lifetime

  /**
   * close closes every source and refuses every later request. It drops
   * sources, waits for the queue to drain, then drops again to close any
   * source an in-flight open added.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.drop();
    await this.queue;
    await this.drop();
  }

  /** live throws if the workspace is closed. */
  private live(): void {
    if (this.closed) throw new Refusal({ t: "workspace-closed" });
  }

  private need(id: string): Source {
    this.live();
    const source = this.sources.get(id);
    if (source === undefined) {
      const none = this.sources.size === 0;
      throw new Refusal(none ? { t: "no-file-open" } : { t: "no-such-source", id });
    }
    return source;
  }

  /** needView is `need`, and throws for an Absent. */
  private needView(id: string): View {
    const source = this.need(id);
    if (!(source instanceof View)) {
      throw new Refusal({ t: "source-absent", name: source.name });
    }
    return source;
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      this.live();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** pathsOf returns every address a .uno source reads from. A carried source has none. */
function pathsOf(src: Held): string[] {
  if (src.parts !== undefined) return src.parts.map((part) => part.path);
  return src.raw === undefined && src.path !== undefined ? [src.path] : [];
}

/**
 * sizeOf returns the saved size of a .uno source: its file's size, or the
 * joined size of its parts.
 */
function sizeOf(kept: Part): number {
  return kept.parts !== undefined ? partMap(kept.parts).size : (kept.bytes ?? 0);
}

/**
 * joinedFrom builds the parts ref a saved multi-file source is reopened by:
 * each part by path and saved version, with the extent the save measured.
 */
function joinedFrom(src: Pick<HeldParts, "name" | "parts" | "header" | "fileColumn">): PartsRef {
  return {
    name: src.name,
    parts: src.parts.map((part) => ({
      ref: fileAt(part.name, part.path, part.version),
      extent: { bytes: part.bytes, skip: part.skip, unterminated: part.unterminated },
    })),
    header: src.header,
    fileColumn: src.fileColumn,
  };
}

/**
 * pointedTo returns the ref a relink opens. For a single-file source it is
 * the given ref. For a multi-file source it is the given ref with the
 * source's header mode, and each part keeping its saved version if its path
 * is unchanged, and its saved extent either way.
 *
 * It refuses a part count that differs from the source's, and a single file
 * for a multi-file source or the reverse.
 */
function pointedTo(was: Source, ref: SourceRef): SourceRef {
  const made = was.parts;
  if (made === undefined) {
    if (!("parts" in ref)) return ref;
    throw new Refusal({
      t: "point-one-at-several",
      file: ref.name,
      count: ref.parts.length,
      name: was.name,
    });
  }
  const count = made.parts.length;
  if (!("parts" in ref)) {
    throw new Refusal({ t: "point-several-at-one", name: was.name, count, file: ref.name });
  }
  if (ref.parts.length !== count) {
    throw new Refusal({
      t: "point-several-at-other",
      name: was.name,
      count,
      given: ref.parts.length,
    });
  }
  return {
    ...made,
    name: ref.name,
    parts: ref.parts.map((part, i) => {
      const { ref: file, extent } = made.parts[i]!;
      const stayed = "path" in part.ref && "path" in file && part.ref.path === file.path;
      const now = stayed ? file : part.ref;
      return extent === undefined ? { ref: now } : { ref: now, extent };
    }),
  };
}

/** pathsIn returns every address a ref reads from, in order. A dropped file has none. */
function pathsIn(ref: SourceRef): string[] {
  const files = "parts" in ref ? ref.parts.map((part) => part.ref) : [ref];
  return files.flatMap((file) => ("path" in file ? [file.path] : []));
}

/** sameList reports whether two address lists are equal element by element. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

/** fileAt builds a SingleRef from a name, path, and optional version. */
function fileAt(name: string, path: string, version: string | undefined): SingleRef {
  return version === undefined ? { name, path } : { name, path, version };
}

/**
 * linkOf returns a reopened source's link with `changed` set when the file
 * differs from what the log was made against.
 */
function linkOf(view: View, src: Held): Link | undefined {
  const link = view.opened.link;
  if (link === undefined) return undefined;
  const changed = changeOf(view, src);
  return changed === undefined ? link : { ...link, changed };
}

/**
 * changeOf describes how a reopened source's bytes differ from the saved
 * ones, or undefined when every comparable field matches.
 *
 * When both sides have a version, equal versions mean unchanged, and
 * different versions report "version-changed". Otherwise a size difference
 * reports "size-changed". A saved size of 0 is treated as unknown.
 */
function changeOf(view: View, src: Held): Said | undefined {
  const was = src.bytes ?? 0;
  const sizes = was === 0 || was === view.size ? undefined : { now: view.size, was };
  if (src.version !== undefined && view.version !== undefined) {
    if (src.version === view.version) return undefined;
    return sizes === undefined
      ? { t: "version-changed", name: src.name }
      : { t: "version-changed", name: src.name, sizes };
  }
  return sizes === undefined ? undefined : { t: "size-changed", name: src.name, ...sizes };
}

/**
 * interleave lays each source's edits out in trail order. It throws if the
 * trail and the per-source logs disagree on edit counts.
 */
function interleave(trail: readonly string[], parts: ReadonlyMap<string, Part>): Logged[] {
  const next = new Map<string, number>();
  const log: Logged[] = trail.map((source) => {
    const i = next.get(source) ?? 0;
    const edit = parts.get(source)?.edits[i];
    if (edit === undefined) throw new Refusal({ t: "log-lost-edit", source });
    next.set(source, i + 1);
    return { source, edit };
  });
  for (const [source, part] of parts) {
    if ((next.get(source) ?? 0) !== part.edits.length) {
      throw new Refusal({ t: "log-lost-edit", source });
    }
  }
  return log;
}
