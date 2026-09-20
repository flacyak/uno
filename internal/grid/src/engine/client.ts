// The client half: what a renderer holds in place of a workspace.
//
// Engine turns the protocol back into promises, and hands out one SourceHandle
// per source for the requests that name one. Band is the rows around the
// viewport, the one piece of a file a renderer keeps, and it answers the grid
// synchronously: a row that has not arrived is pending, never awaited.

import type {
  Changed,
  ColumnInfo,
  EditRequest,
  FindRequest,
  Found,
  Offer,
  Opened,
  Place,
  Port,
  Progress,
  Reply,
  Request,
  SourceRef,
} from "./protocol.ts";
import { messageOf } from "./protocol.ts";

interface Waiter<T> {
  resolve(value: T): void;
  reject(err: Error): void;
}

/** A page of rows as the engine sends it. */
export interface RowsReply {
  first: number;
  generation: number;
  rows: string[][];
  raws: Array<string[] | null>;
}

/** What an open added: one handle per source, and which one to show. */
export interface Added {
  sources: SourceHandle[];
  showing: string;
}

export class Engine {
  /** A failure nothing was waiting on: an index, a survey, or a band request. */
  onError: (message: string) => void = () => {};

  private next = 1;
  private readonly waiting = new Map<number, Waiter<Reply>>();
  private readonly sources = new Map<string, SourceHandle>();
  private closed = false;

  constructor(private readonly port: Port<Reply, Request>) {
    port.listen((msg) => this.receive(msg));
  }

  /**
   * open adds a file to the workspace. A .uno opens every source it holds, and
   * only into an engine that holds none.
   */
  async open(ref: SourceRef): Promise<Added> {
    const r = await this.ask((id) => ({ t: "open", id, ref }));
    if (r.t !== "opened") throw new Error(`the engine answered an open with ${r.t}`);
    const sources = r.added.opened.map((o) => {
      const s = new SourceHandle(this, o);
      this.sources.set(o.source, s);
      return s;
    });
    return { sources, showing: r.added.showing };
  }

  /** remove takes a source out of the workspace, and its edits out of the log. */
  async remove(source: SourceHandle): Promise<void> {
    const r = await this.ask((id) => ({ t: "remove", id, source: source.id }));
    if (r.t !== "removed") throw new Error(`the engine answered a remove with ${r.t}`);
    this.sources.delete(source.id);
  }

  /**
   * relink points a source at a file: the one whose file has gone, or one whose
   * file changed under the log.
   *
   * It answers with a new handle, because the columns, the progress and the log
   * all belong to the file that is now behind it. Whoever holds the old one
   * throws it away, along with the band of rows it was serving.
   */
  async relink(source: SourceHandle, ref: SourceRef): Promise<SourceHandle> {
    const r = await this.ask((id) => ({ t: "relink", id, source: source.id, ref }));
    if (r.t !== "relinked") throw new Error(`the engine answered a relink with ${r.t}`);
    const handle = new SourceHandle(this, r.opened);
    this.sources.set(handle.id, handle);
    return handle;
  }

  mode(transform: boolean): void {
    if (!this.closed) this.port.post({ t: "mode", transform });
  }

  /** save returns the workspace as a .uno, refusing carried sources larger than
   * limit together. */
  async save(place: Place, limit: number): Promise<Uint8Array> {
    const r = await this.ask((id) => ({ t: "save", id, place, limit }));
    if (r.t !== "saved") throw new Error(`the engine answered a save with ${r.t}`);
    return r.bytes;
  }

  /** close ends the connection. The worker behind it goes when its port does. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.post({ t: "close" });
    this.port.close();

    const gone = new Error("the engine was closed");
    for (const w of this.waiting.values()) w.reject(gone);
    this.waiting.clear();
  }

  /** ask sends a request and resolves with its answer. For SourceHandle. */
  ask(make: (id: number) => Request): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error("the engine was closed"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.port.post(make(id));
    });
  }

  private receive(msg: Reply): void {
    switch (msg.t) {
      case "progress": {
        const s = this.sources.get(msg.source);
        if (s === undefined) return;
        s.progress = msg.progress;
        s.onProgress(msg.progress);
        return;
      }

      case "offer": {
        const s = this.sources.get(msg.source);
        // An offer about an older log is a question about something that is no
        // longer there.
        if (s === undefined || msg.generation < s.generation) return;
        s.generation = msg.generation;
        s.onOffer(msg.offer);
        return;
      }

      case "changed": {
        const s = this.sources.get(msg.source);
        if (s !== undefined) s.generation = Math.max(s.generation, msg.changed.generation);
        this.settle(msg.id, msg);
        return;
      }

      case "error": {
        const err = new Error(msg.message);
        if (msg.id !== undefined) {
          this.waiting.get(msg.id)?.reject(err);
          this.waiting.delete(msg.id);
        } else {
          this.onError(msg.message);
        }
        return;
      }

      default:
        this.settle(msg.id, msg);
    }
  }

  private settle(id: number, msg: Reply): void {
    this.waiting.get(id)?.resolve(msg);
    this.waiting.delete(id);
  }
}

/**
 * SourceHandle is one source in an engine's workspace: what the engine said
 * when it opened, what it has said since, and the requests that name it.
 */
export class SourceHandle {
  /** The latest the engine has said about this source's index. */
  progress: Progress;
  /** The newest log the engine has said this source holds. Rows built before it are stale. */
  generation: number;

  onProgress: (progress: Progress) => void = () => {};
  /** The recogniser's question, or null when there is none. */
  onOffer: (offer: Offer | null) => void = () => {};

  constructor(
    readonly engine: Engine,
    readonly opened: Opened,
  ) {
    this.progress = opened.progress;
    this.generation = opened.generation;
  }

  /** What the workspace and its log call this source. */
  get id(): string {
    return this.opened.source;
  }

  async rows(first: number, count: number): Promise<RowsReply> {
    const r = await this.engine.ask((id) => ({ t: "rows", id, source: this.id, first, count }));
    if (r.t !== "rows") throw new Error(`the engine answered a rows request with ${r.t}`);
    return r;
  }

  async edit(edit: EditRequest): Promise<Changed> {
    const r = await this.engine.ask((id) => ({ t: "edit", id, source: this.id, edit }));
    if (r.t !== "changed") throw new Error(`the engine answered an edit with ${r.t}`);
    return r.changed;
  }

  async undo(): Promise<Changed> {
    const r = await this.engine.ask((id) => ({ t: "undo", id, source: this.id }));
    if (r.t !== "changed") throw new Error(`the engine answered an undo with ${r.t}`);
    return r.changed;
  }

  async redo(): Promise<Changed> {
    const r = await this.engine.ask((id) => ({ t: "redo", id, source: this.id }));
    if (r.t !== "changed") throw new Error(`the engine answered a redo with ${r.t}`);
    return r.changed;
  }

  /** find asks for the next matching row in a column, however far from the band it is. */
  async find(find: FindRequest): Promise<Found> {
    const r = await this.engine.ask((id) => ({ t: "find", id, source: this.id, find }));
    if (r.t !== "found") throw new Error(`the engine answered a find with ${r.t}`);
    return r.found;
  }
}

/** Rows kept around the viewport. Several screens, so a wheel rarely outruns them. */
const BAND_ROWS = 2000;

/** A value shown before the engine has recorded it, and what it covered. */
export interface Pending {
  row: number;
  col: number;
  value: string;
  was: string;
  shown: string;
}

/**
 * Band is the rows around the viewport.
 *
 * It has the reading half of a Sheet's surface -- `rows`, `cols`, `columns`,
 * `display`, `raw`, `binding` -- so the grid draws either without knowing which.
 * Every read is an array lookup, because the grid calls it for every visible
 * cell on every frame.
 *
 * When the log changes, the rows it holds are stale. It keeps drawing them until
 * the new ones land, so nothing on screen blinks empty, and a value a person
 * just typed is laid over whatever arrives until the engine has recorded it.
 */
export class Band {
  columns: readonly ColumnInfo[];

  private start = 0;
  private data: string[][] = [];
  private raws: Array<string[] | null> = [];
  private generation: number;
  private readonly pending: Pending[] = [];
  private asking = false;
  private broken = false;

  constructor(
    private readonly source: SourceHandle,
    /** Called when rows land, so whoever draws can draw them. */
    private readonly changed: () => void,
  ) {
    this.columns = source.opened.columns;
    this.generation = source.opened.generation;
  }

  rows(): number {
    return this.source.progress.rows;
  }

  cols(): number {
    return this.columns.length;
  }

  /**
   * readable is how many rows the engine can answer for now. Until the index is
   * complete, `rows` is a projection past it, and a motion to the end stops here.
   */
  readable(): number {
    return this.source.progress.readable;
  }

  /** ready reports whether a row has arrived. One that has not is drawn as pending. */
  ready(row: number): boolean {
    return row >= this.start && row < this.start + this.data.length;
  }

  display(row: number, col: number): string {
    return this.data[row - this.start]?.[col] ?? "";
  }

  raw(row: number, col: number): string {
    const i = row - this.start;
    return this.raws[i]?.[col] ?? this.data[i]?.[col] ?? "";
  }

  binding(col: number): string | undefined {
    return this.columns[col]?.binding;
  }

  /**
   * write shows a typed value at once. The returned token settles it: `settle`
   * once the engine has recorded the edit, `restore` if the engine refused it.
   */
  write(row: number, col: number, value: string): Pending {
    const p = { row, col, value, was: this.raw(row, col), shown: this.display(row, col) };
    this.pending.push(p);
    this.put(row, col, value, value);
    return p;
  }

  settle(p: Pending): void {
    const i = this.pending.indexOf(p);
    if (i >= 0) this.pending.splice(i, 1);
  }

  /** restore puts back what a refused edit replaced. */
  restore(p: Pending): void {
    this.settle(p);
    this.put(p.row, p.col, p.shown, p.was);
  }

  private put(row: number, col: number, shown: string, raw: string): void {
    const i = row - this.start;
    const cells = this.data[i];
    if (cells === undefined) return;
    cells[col] = shown;
    const stored = this.raws[i];
    if (stored !== undefined && stored !== null) stored[col] = raw;
  }

  /**
   * view tells the band what is on screen. The grid calls it on every layout,
   * so the usual case compares a few numbers and returns.
   *
   * It asks for a new band when one screen either side of the viewport is not
   * covered, or when the rows it holds were built from an older log, and one
   * request is in flight at most. The reply's `changed` redraws the grid, which
   * calls this again, which is how a viewport that moved while the request was
   * out gets its own.
   */
  view(first: number, count: number): void {
    if (this.asking || this.broken) return;

    const readable = this.source.progress.readable;
    const lo = Math.max(0, first - count);
    const hi = Math.min(readable, first + 2 * count);
    if (lo >= hi) return;
    const covered = lo >= this.start && hi <= this.start + this.data.length;
    if (covered && this.generation >= this.source.generation) return;

    const from = Math.max(
      0,
      Math.min(first + (count >> 1) - (BAND_ROWS >> 1), readable - BAND_ROWS),
    );
    this.asking = true;
    this.source.rows(from, BAND_ROWS).then(
      (r) => {
        this.asking = false;
        // Built before an edit that has since been recorded. Ask again rather
        // than draw a value the person has already changed.
        if (r.generation < this.source.generation) {
          this.changed();
          return;
        }
        this.start = r.first;
        this.data = r.rows;
        this.raws = r.raws;
        this.generation = r.generation;
        for (const p of this.pending) this.put(p.row, p.col, p.value, p.value);
        this.changed();
      },
      (err: unknown) => {
        // A block that cannot be read will not be readable on the next frame
        // either. Asking again sixty times a second would say nothing new.
        this.asking = false;
        this.broken = true;
        this.source.engine.onError(messageOf(err));
      },
    );
  }
}
