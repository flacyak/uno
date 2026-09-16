// The client side of the engine protocol.
//
// Engine wraps the protocol in promises and hands out one SourceHandle per
// source. Band holds the rows around the viewport and answers the grid
// synchronously. A row still in flight is reported as such.

import type {
  Changed,
  ColumnInfo,
  EditRequest,
  FindRequest,
  Found,
  Loaded,
  Offer,
  Opened,
  Peeked,
  Place,
  Port,
  Progress,
  Reply,
  Request,
  SignIns,
  SourceRef,
} from "./protocol.ts";
import { Refusal, saidOf } from "../said/index.ts";
import type { Said } from "../said/index.ts";
import type { Connection } from "../library/index.ts";
import type { Entry, Listing, SingleRef } from "../store/index.ts";
import type { Tried } from "../store/s3.ts";

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
  /** Called with a failure outside any request: an index, a survey, a band, or a lost connection. */
  onError: (said: Said) => void = () => {};

  private next = 1;
  private readonly waiting = new Map<number, Waiter<Reply>>();
  private readonly sources = new Map<string, SourceHandle>();
  /** Set once closed or the connection is lost. Every later request rejects with it. */
  private gone: Error | undefined;

  constructor(private readonly port: Port<Reply, Request>) {
    port.listen(
      (msg) => this.receive(msg),
      () => this.lost(),
    );
  }

  /**
   * open adds a file to the workspace. A .uno opens every source it holds,
   * and only into an empty workspace.
   */
  async open(ref: SourceRef): Promise<Added> {
    const { added } = await this.ask("opened", (id) => ({ t: "open", id, ref }));
    return { sources: added.opened.map((o) => this.adopt(o)), showing: added.showing };
  }

  /** remove takes a source out of the workspace, and its edits out of the log. */
  async remove(source: SourceHandle): Promise<void> {
    await this.ask("removed", (id) => ({ t: "remove", id, source: source.id }));
    this.sources.delete(source.id);
  }

  /**
   * relink points a source at a different file and returns a new handle for
   * it. The old handle and any Band over it should be dropped.
   *
   * A source that was waiting for its bucket to be connected may still come
   * back absent; its link says why.
   */
  async relink(source: SourceHandle, ref: SourceRef): Promise<SourceHandle> {
    const r = await this.ask("relinked", (id) => ({ t: "relink", id, source: source.id, ref }));
    return this.adopt(r.opened);
  }

  /**
   * append adds files at the end of a source that reads several files as one
   * and returns a new handle for it. The log is unchanged.
   */
  async append(source: SourceHandle, parts: SingleRef[]): Promise<SourceHandle> {
    const r = await this.ask("appended", (id) => ({ t: "append", id, source: source.id, parts }));
    return this.adopt(r.opened);
  }

  /** adopt makes a handle for an opened source and registers it by id. */
  private adopt(opened: Opened): SourceHandle {
    const handle = new SourceHandle(this, opened);
    this.sources.set(handle.id, handle);
    return handle;
  }

  mode(transform: boolean): void {
    if (this.gone === undefined) this.port.post({ t: "mode", transform });
  }

  /** save returns the workspace as a .uno. Refused if carried sources total
   * more than limit bytes. */
  async save(place: Place, limit: number): Promise<Uint8Array> {
    return (await this.ask("saved", (id) => ({ t: "save", id, place, limit }))).bytes;
  }

  /** list returns one page of a folder or prefix listing. */
  async list(path: string, cursor?: string): Promise<Listing> {
    return (await this.ask("listed", (id) => ({ t: "list", id, path, cursor }))).listing;
  }

  /** stat returns the size and version of a path, from its metadata alone. */
  async stat(path: string): Promise<Entry> {
    return (await this.ask("statted", (id) => ({ t: "stat", id, path }))).entry;
  }

  /**
   * peek returns a file's format label, header and first rows, read apart
   * from the workspace.
   */
  async peek(ref: SourceRef): Promise<Peeked> {
    return (await this.ask("peeked", (id) => ({ t: "peek", id, ref }))).peeked;
  }

  /** connections has the engine reload its connections and returns them. */
  async connections(): Promise<Loaded> {
    return (await this.ask("loaded", (id) => ({ t: "connections", id }))).loaded;
  }

  /** signIns returns the engine's sign-in modes, profile names, and role trust. */
  async signIns(): Promise<SignIns> {
    return (await this.ask("offered", (id) => ({ t: "signins", id }))).signins;
  }

  /**
   * tryConnection has the engine try an unsaved connection: find its
   * bucket's region and list a page of its prefix. The connection is dropped
   * afterwards.
   */
  async tryConnection(connection: Connection): Promise<Tried> {
    return (await this.ask("tried", (id) => ({ t: "try", id, connection }))).tried;
  }

  /** close sends a close request, closes the port, and rejects every pending request. */
  close(): void {
    if (this.gone !== undefined) return;
    this.gone = new Error("the engine was closed");
    this.port.post({ t: "close" });
    this.port.close();
    this.refuse(this.gone);
  }

  /**
   * lost runs when the far end closes first. It rejects every pending
   * request and reports the loss once through `onError`.
   */
  private lost(): void {
    if (this.gone !== undefined) return;
    const said: Said = { t: "text", text: "the connection to the engine closed" };
    this.gone = new Refusal(said);
    this.port.close();
    this.refuse(this.gone);
    this.onError(said);
  }

  private refuse(why: Error): void {
    for (const w of this.waiting.values()) w.reject(why);
    this.waiting.clear();
  }

  /**
   * ask sends a request and resolves with its reply. A reply of a kind other
   * than `want` is an error. Public for SourceHandle.
   */
  async ask<K extends Reply["t"]>(
    want: K,
    make: (id: number) => Request,
  ): Promise<Extract<Reply, { t: K }>> {
    if (this.gone !== undefined) throw this.gone;
    const id = this.next++;
    const request = make(id);
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.port.post(request);
    });
    if (!isKind(reply, want)) {
      throw new Error(`the engine answered a ${request.t} request with ${reply.t}`);
    }
    return reply;
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
        // Drop an offer built from an older generation of the log.
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
        if (msg.id !== undefined) {
          // Rejected as a Refusal, so the Said stays data on this side too.
          this.waiting.get(msg.id)?.reject(new Refusal(msg.said));
          this.waiting.delete(msg.id);
        } else {
          this.onError(msg.said);
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
 * SourceHandle is one source in an engine's workspace. It holds what the
 * engine said on open and since, and sends the requests that name it.
 */
export class SourceHandle {
  /** The latest index progress the engine reported. */
  progress: Progress;
  /** The latest log generation the engine reported. Rows built before it are stale. */
  generation: number;

  onProgress: (progress: Progress) => void = () => {};
  /** Called with the recogniser's proposal, or null when there is none. */
  onOffer: (offer: Offer | null) => void = () => {};

  constructor(
    readonly engine: Engine,
    readonly opened: Opened,
  ) {
    this.progress = opened.progress;
    this.generation = opened.generation;
  }

  /** The source's id in the workspace and its log. */
  get id(): string {
    return this.opened.source;
  }

  rows(first: number, count: number): Promise<RowsReply> {
    return this.engine.ask("rows", (id) => ({ t: "rows", id, source: this.id, first, count }));
  }

  async edit(edit: EditRequest): Promise<Changed> {
    return (await this.engine.ask("changed", (id) => ({ t: "edit", id, source: this.id, edit })))
      .changed;
  }

  async undo(): Promise<Changed> {
    return (await this.engine.ask("changed", (id) => ({ t: "undo", id, source: this.id }))).changed;
  }

  async redo(): Promise<Changed> {
    return (await this.engine.ask("changed", (id) => ({ t: "redo", id, source: this.id }))).changed;
  }

  /** find asks the engine for the next matching row in a column. */
  async find(find: FindRequest): Promise<Found> {
    return (await this.engine.ask("found", (id) => ({ t: "find", id, source: this.id, find })))
      .found;
  }
}

/** isKind narrows a reply to one kind. */
function isKind<K extends Reply["t"]>(reply: Reply, kind: K): reply is Extract<Reply, { t: K }> {
  return reply.t === kind;
}

/** Rows a Band requests at a time, centred on the viewport. */
export const BAND_ROWS = 2000;

/** A typed value shown before the engine has recorded it, and the values it replaced. */
export interface Pending {
  row: number;
  col: number;
  value: string;
  was: string;
  shown: string;
}

/**
 * Band holds the rows around the viewport.
 *
 * It has the same read methods as a Sheet (`rows`, `cols`, `columns`,
 * `display`, `raw`, `binding`), so the grid can draw either. Every read is an
 * array lookup.
 *
 * When the log changes, the held rows are stale. They are drawn until the new
 * ones arrive. A value typed by the person is laid over the rows that arrive
 * until the engine has recorded it.
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
   * readable returns how many rows the engine can serve now. Until the index
   * is complete, `rows` is an estimate past it.
   */
  readable(): number {
    return this.source.progress.readable;
  }

  /** ready reports whether a row is in the band. */
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
   * write shows a typed value at once and returns a Pending token. Call
   * `settle` once the engine has recorded the edit, or `restore` if it
   * refused it.
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

  /** restore puts back the values a refused edit replaced. */
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
   * view tells the band what is on screen. The grid calls it on every layout.
   *
   * It requests a new band when the held rows stop short of one screen either
   * side of the viewport, or when they are from an older log generation. At
   * most one request is in flight. The `changed` callback redraws the grid,
   * which calls this again.
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
        // The reply is from an older generation. Trigger a redraw so view
        // asks again.
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
        // Stop asking after a failed read. It would fail again on every frame.
        this.asking = false;
        this.broken = true;
        this.source.engine.onError(saidOf(err));
      },
    );
  }
}
