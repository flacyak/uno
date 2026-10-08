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
 * The largest .uno read whole.
 *
 * It bounds the container and not the data in it. A workspace that points at
 * five 4 GB exports is a few kilobytes of JSON, and nothing under this ceiling
 * is a file anybody meant to make by hand.
 */
export const WHOLE_LIMIT = 256 << 20;

/**
 * Absent is a source the workspace could not open: the file it pointed at has
 * moved, or been deleted, or will not parse, or one of the parts it reads as
 * one has.
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
    /**
     * Everything a save writes of it, as the .uno held it: the pointer and
     * which bytes it was made against, or every part's, or the bytes a
     * container carried for a source that had no path and would not parse.
     * Those go back in at the next save: uno could not read them, but that is
     * not a reason to be the thing that finally loses them.
     */
    private readonly kept: Part,
    why: Said,
    /** The bucket it reads that no connection covers, when that is why. */
    connect?: Unconnected,
  ) {
    const path = this.path;
    const size = sizeOf(kept);
    this.opened = {
      source: id,
      name,
      size,
      columns: [],
      // Complete, because nothing is going to arrive. A grid that waits for rows
      // out of a file that is not there waits forever, and says "indexing 0%"
      // the whole time.
      progress: { done: 0, total: size, readable: 0, rows: 0, complete: true },
      edits: kept.edits,
      generation: 0,
      link: connect === undefined ? { path, missing: why } : { path, missing: why, connect },
    };
  }

  /** Where the file was, or "" for bytes the container carried and for
   * several files read as one, which have no one path. */
  get path(): string {
    return this.kept.path ?? "";
  }

  /** The parts it reads as one, for a source that is several: each where the
   * .uno said it was, with the extent the save measured of it. */
  get parts(): PartsRef | undefined {
    const kept = this.kept;
    if (kept.parts === undefined) return undefined;
    return joinedFrom({
      name: this.name,
      parts: kept.parts,
      header: kept.header,
      fileColumn: kept.fileColumn,
    });
  }

  /** Whatever the container carried for it, which for a pointed-at source is
   * nothing. */
  get carries(): number {
    return this.kept.raw?.length ?? 0;
  }

  /** What a save writes: the pointer or the bytes it was given, and the log,
   * all exactly as they were read. */
  part(): Promise<Part> {
    return Promise.resolve(this.kept);
  }

  /** The log as it stands, which is what a relink replays over the file it is
   * pointed at. */
  get log(): Edit[] {
    return this.kept.edits;
  }

  /** The bucket it waits to have connected, when that is why it has no file. */
  get waiting(): Unconnected | undefined {
    return this.opened.link?.connect;
  }

  /**
   * missing is this source once it has stopped waiting for its bucket but its
   * file still does not open: the same source, saying why it has no file.
   */
  missing(why: Said): Absent {
    return new Absent(this.id, this.name, this.kept, why);
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
    /** Every kind of place this engine can open a file from. */
    private readonly handlers: readonly FileHandler[],
    private readonly port: Port<Request, Reply>,
    private readonly tuning: Tuning,
    /**
     * Which connection an address is read through, or the bucket no connection
     * covers. Undefined for a platform with no connections, and its answer
     * undefined for an address that is not in a bucket.
     */
    private readonly meet?: (path: string) => Meeting | undefined,
    /** Told how long each source took to index. */
    private readonly telemetry: Telemetry = unmeasured,
  ) {}

  /**
   * openSource opens a ref through whichever handler claims it: a path on a
   * disk, an object in a bucket, a dropped Blob. It is the only way a source or
   * a .uno comes in, so what this engine can read is exactly the handlers its
   * platform listed.
   */
  private openSource(ref: SourceRef): Promise<ByteSource> {
    return openWith(this.handlers, ref);
  }

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
      // Several files read as one are a source whatever they are called.
      const workspace = !("parts" in ref) && ref.name.toLowerCase().endsWith(".uno");
      if (workspace) return this.openWorkspace(ref);
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
        throw new Refusal({ t: "only-source", name: source.name });
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
   *
   * The one exception is a source that was waiting for its bucket to be
   * connected, read where it already points once a connection covers it. It
   * is not waiting any more whether or not the read works, so a read that
   * fails leaves it missing and saying why, and that is the answer: asking
   * again to connect a bucket that is connected would send the person round
   * the same form for nothing.
   *
   * Several files read as one are pointed at as many again, part for part:
   * the one that moved where it is now, the others where they were. No part
   * may change under the log. Each is held to the extent a save recorded of
   * the part in its place, because the log names rows by number and another
   * file there would move every row after it out from under its edits. And
   * each is opened before the source is swapped, so a part that is still gone
   * is refused by name here and not by whichever read reaches it later.
   *
   * One file is still refused several, and several one.
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

      // Only once the new one is open, so a refused relink leaves the source
      // showing whatever it was showing before.
      return this.replace(was, view);
    });
  }

  /**
   * append adds files at the end of a source that is several read as one.
   *
   * The parts it has keep their places in the list, so every row keeps its
   * number, and the log is replayed as it stands over the longer source:
   * nothing in it is rewritten and nothing is added to it. The id stays, which
   * is what keeps the log attached, as it does through a relink.
   *
   * A file is held to the first part as it would have been had the source
   * been opened with it. One that reads differently is refused naming it and
   * what differs, and so is a file the source already reads, whose rows would
   * be there twice. A refused append leaves the source as it was.
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

      // Only once the longer one is open, so a refused append leaves the
      // source showing what it was showing before.
      return this.replace(was, view);
    });
  }

  /** A .uno's sources: each opened from the file it points at, or carried. */
  private async openWorkspace(ref: SourceRef): Promise<Opening> {
    if (this.sources.size > 0) {
      throw new Refusal({ t: "workspace-as-source", name: ref.name });
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
   * reopen builds one source of a .uno back: from the file it points at, from
   * the parts it reads as one, or from the bytes it carried.
   *
   * A source that will not open is an Absent rather than a failed open of the
   * whole workspace. Refusing all of it over one moved CSV would leave a person
   * with a file full of their own work and no way into it.
   *
   * Several files read as one come back with the extent the save measured of
   * each part, so none of them is opened here: a part is opened by the first
   * read that reaches it, and held then to what the save recorded of it.
   */
  private async reopen(container: string, src: Held, edits: Edit[]): Promise<Source> {
    const kept = keptOf(src, edits);
    // A .uno travels, and the person opening one did not choose the buckets
    // it names. One no connection covers is not read at all -- not a HEAD --
    // until they connect it: the source is kept, edits and all, and says why.
    // Every part of several files is asked about before any of them is read,
    // so one part in a bucket nobody connected keeps the rest unread too.
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
            ? // By where the file is, and which bytes of it the log was made
              // against, for a place that can hand those over again.
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

  /** The bucket an address is in that no connection covers, if it is. */
  private unconnected(path: string): Unconnected | undefined {
    const met = this.meet?.(path);
    return met !== undefined && "unconnected" in met ? met.unconnected : undefined;
  }

  /**
   * The first bucket a source of a .uno would read that no connection covers:
   * the one its file is in, or the one any of its parts is in. A carried
   * source reads no bucket.
   */
  private unconnectedIn(src: Held): Unconnected | undefined {
    for (const path of pathsOf(src)) {
      const needs = this.unconnected(path);
      if (needs !== undefined) return needs;
    }
    return undefined;
  }

  /**
   * The connection a ref is read through, for the save to write down as a
   * hint. Several files have one where every part that is in a bucket came
   * through the same connection, and none where they came through more than
   * one: the hint is one id, and an opener matches each part's address to its
   * own connections regardless.
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

  /** view opens one file as a source, through whatever this platform hands back
   * for a SourceRef. A ref with no path is bytes a save will have to carry, or
   * several files read as one, which the view keeps the parts of. `whole`
   * opens every one of those parts first, for a caller that must know none is
   * gone before it has a source at all. */
  private async view(
    id: string,
    ref: SourceRef,
    carried: Carried | undefined,
    whole = false,
  ): Promise<View> {
    const path = "path" in ref ? ref.path : "";
    const source = await this.openSource(ref);
    // Opened whole, each part of several files read as one that no read has
    // reached yet is opened too, which is what holds it to its extent: asking a
    // part its version is asking for the part. One that will not open, or is
    // another file, closes the source and is the error, by name. Any other
    // source has no parts and is left alone.
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
      // Only several files read as one say whether they have a header row.
      // One file on its own has one.
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

  /** replace puts `now` where `was` stood, under the same id, and closes what was there. */
  private async replace(was: Source, now: View): Promise<Opened> {
    const opened = this.keep(now);
    await was.close();
    return opened;
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
    return this.changing(id, (view) => view.edit(req), "push");
  }

  /** undo takes back the source's last edit, wherever it sits in the workspace's log. */
  undo(id: string): Promise<Changed> {
    return this.changing(id, (view) => view.undo(), "pull");
  }

  redo(id: string): Promise<Changed> {
    return this.changing(id, (view) => view.redo(), "push");
  }

  /**
   * changing is one change to a source's log, run in its turn, and then the
   * workspace's trail of which source changed last kept with it: an edit and
   * a redo push the source onto it, and an undo pulls its last mention off.
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
        const held = {
          id: source.id,
          name: source.name,
          connection: part.connection,
          rows: part.rows,
          cols: part.cols,
          state,
        };
        return part.parts !== undefined
          ? { ...held, parts: part.parts, header: part.header, fileColumn: part.fileColumn }
          : { ...held, raw: part.raw, path: part.path, bytes: part.bytes, version: part.version };
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
   * refuseOver stops a save that would have to carry more bytes than a container
   * should hold.
   *
   * Only a source with no file behind it counts: bytes dropped into a browser
   * tab, which uno has nothing to point at and so must copy or lose. Everything
   * opened from a path is a path in the manifest and weighs nothing, and so
   * are several files read as one, whose every part is pointed at.
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
   * refuseWhere stops a save that would write the .uno over a file the
   * workspace reads, or point at a file by a path that is true from nowhere.
   *
   * The first would destroy the source, and the dialog makes it easy: it opens
   * on the folder the data is in, where sales.csv is a name already there. The
   * second is a file opened by a path relative to the process that opened it,
   * `uno data/sales.csv` from a terminal. Written down as it is, the path would
   * be read back from the .uno's own folder, and the file is not there: the
   * manifest only ever holds a path that is absolute or under that folder.
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
   * close closes every source, and nothing is opened after it.
   *
   * What the workspace holds is closed at once. An open already under way
   * lands after that with a file of its own, so the queue is waited out and
   * what it left is closed as well. Whatever was still waiting its turn is
   * refused before it starts.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.drop();
    await this.queue;
    await this.drop();
  }

  /** live refuses whatever is asked of a workspace that was closed. */
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

  /** needView is `need` for the requests that read or change rows, which an
   * Absent has none of. */
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

/** What a save writes back of a source of a .uno, exactly as the .uno held it. */
function keptOf(src: Held, edits: Edit[]): Part {
  const kept = { connection: src.connection, edits, rows: src.rows, cols: src.cols };
  return src.parts !== undefined
    ? { ...kept, parts: src.parts, header: src.header, fileColumn: src.fileColumn }
    : { ...kept, raw: src.raw, path: src.path, bytes: src.bytes ?? 0, version: src.version };
}

/** Every address a source of a .uno is read from, which for one it carries
 * is none. */
function pathsOf(src: Held): string[] {
  if (src.parts !== undefined) return src.parts.map((part) => part.path);
  return src.raw === undefined && src.path !== undefined ? [src.path] : [];
}

/**
 * sizeOf is how big a source a .uno held is: what its file measured, or how
 * long its parts are once joined, which is the size it opens at.
 */
function sizeOf(kept: Part): number {
  return kept.parts !== undefined ? partMap(kept.parts).size : kept.bytes;
}

/**
 * joinedFrom is the ref several files read as one are opened by again: each
 * part where it is, pinned to the bytes the log was made against, and beside
 * it the extent the save measured, which is what leaves it unopened until a
 * read reaches it.
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
 * pointedTo is what a relink opens: the ref it was given, or for several
 * files read as one, that ref with each part held to what the source knows of
 * the part in its place.
 *
 * A part still where it was is opened as the source had it, by the version a
 * save recorded. A part somewhere else is opened as it is there, and both are
 * held to the extent the part had, where a save measured one. The header mode
 * is the source's own: it decides which line is row 0, and the log was made
 * against that.
 *
 * It refuses one file for a source that is several, several for one that is
 * one file, and any other number of parts than the source has.
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

/** Every address a ref is read from, in order. A dropped file has none. */
function pathsIn(ref: SourceRef): string[] {
  const files = "parts" in ref ? ref.parts.map((part) => part.ref) : [ref];
  return files.flatMap((file) => ("path" in file ? [file.path] : []));
}

/** Whether two lists of addresses are the same addresses in the same order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

/** One file by its path, and by its version where a save recorded one. */
function fileAt(name: string, path: string, version: string | undefined): SingleRef {
  return version === undefined ? { name, path } : { name, path, version };
}

/**
 * linkOf is what the client is told about the file behind a source it just
 * reopened: where it is, which bytes were read, and how they differ from the
 * ones the log was made against.
 */
function linkOf(view: View, src: Held): Link | undefined {
  const link = view.opened.link;
  if (link === undefined) return undefined;
  const changed = changeOf(view, src);
  return changed === undefined ? link : { ...link, changed };
}

/**
 * changeOf says how the bytes a source reopened differ from the ones its log
 * was made against, or undefined where nothing says they do.
 *
 * A version is the test where the save recorded one: it catches an export
 * written over at the same size, which a size never could, and a version
 * that is the same is the same bytes. A file with no version -- one on a
 * disk, or a workspace saved before versions were -- falls back to its size,
 * the only check free at open.
 *
 * Either way it is said and not acted on. The log still replays, because a
 * person looking at the grid is better placed than uno to say whether it is
 * still the right file.
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
