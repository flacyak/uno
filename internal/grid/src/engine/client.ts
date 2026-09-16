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
  /** A failure nothing was waiting on: an index, a survey, or a band request. */
  onError: (said: Said) => void = () => {};

  private next = 1;
  private readonly waiting = new Map<number, Waiter<Reply>>();
  private readonly sources = new Map<string, SourceHandle>();
  /** Why nothing more can be asked, once nothing can: closed here, or gone there. */
  private gone: Error | undefined;

  constructor(private readonly port: Port<Reply, Request>) {
    port.listen(
      (msg) => this.receive(msg),
      () => this.lost(),
    );
  }

  /**
   * open adds a file to the workspace. A .uno opens every source it holds, and
   * only into an engine that holds none.
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
   * relink points a source at a file: the one whose file has gone, or one whose
   * file changed under the log.
   *
   * It answers with a new handle, because the columns, the progress and the log
   * all belong to the file that is now behind it. Whoever holds the old one
   * throws it away, along with the band of rows it was serving.
   *
   * A source that was waiting for its bucket to be connected can answer with
   * no file behind it still, once connected: its link then says why.
   */
  async relink(source: SourceHandle, ref: SourceRef): Promise<SourceHandle> {
    const r = await this.ask("relinked", (id) => ({ t: "relink", id, source: source.id, ref }));
    return this.adopt(r.opened);
  }

  /**
   * append adds files at the end of a source that is several read as one.
   *
   * It answers with a new handle, as a relink does and for the same reason:
   * the progress and the rows belong to the longer source. The log is the one
   * the old handle had, every edit on the cell it was made to.
   */
  async append(source: SourceHandle, parts: SingleRef[]): Promise<SourceHandle> {
    const r = await this.ask("appended", (id) => ({ t: "append", id, source: source.id, parts }));
    return this.adopt(r.opened);
  }

  /** adopt is the handle for a source the engine has opened, kept by its id for what the engine says of it later. */
  private adopt(opened: Opened): SourceHandle {
    const handle = new SourceHandle(this, opened);
    this.sources.set(handle.id, handle);
    return handle;
  }

  mode(transform: boolean): void {
    if (this.gone === undefined) this.port.post({ t: "mode", transform });
  }

  /** save returns the workspace as a .uno, refusing carried sources larger than
   * limit together. */
  async save(place: Place, limit: number): Promise<Uint8Array> {
    return (await this.ask("saved", (id) => ({ t: "save", id, place, limit }))).bytes;
  }

  /**
   * list answers one page of a folder or a prefix. It lives on Engine and not
   * on SourceHandle because it is asked before there is a source: a panel
   * browsing its way toward something to open, not a source already in the
   * workspace.
   */
  async list(path: string, cursor?: string): Promise<Listing> {
    return (await this.ask("listed", (id) => ({ t: "list", id, path, cursor }))).listing;
  }

  /** stat answers the size and version of a path now, without opening it: the
   * same reason as list, before there is a source to ask instead. */
  async stat(path: string): Promise<Entry> {
    return (await this.ask("statted", (id) => ({ t: "stat", id, path }))).entry;
  }

  /**
   * peek reads enough of a file to show what is in it -- the format it is in,
   * its header, and the first rows -- without adding it to the workspace.
   *
   * It takes a ref for the reason the request does: a file somebody is about
   * to add may have no path to name it by.
   */
  async peek(ref: SourceRef): Promise<Peeked> {
    return (await this.ask("peeked", (id) => ({ t: "peek", id, ref }))).peeked;
  }

  /**
   * connections has the engine read its connections again and answers with
   * them: asked at start, and after one is saved, so what the panel lists and
   * what the engine signs with are the same list.
   */
  async connections(): Promise<Loaded> {
    return (await this.ask("loaded", (id) => ({ t: "connections", id }))).loaded;
  }

  /** signIns answers how the engine signs in: its modes, its machine's profile names, and a role's trust. */
  async signIns(): Promise<SignIns> {
    return (await this.ask("offered", (id) => ({ t: "signins", id }))).signins;
  }

  /**
   * tryConnection has the engine try a connection nobody has saved yet: its
   * bucket's region, and a page of its prefix. It rejects in the words that
   * stopped it, and keeps nothing either way.
   */
  async tryConnection(connection: Connection): Promise<Tried> {
    return (await this.ask("tried", (id) => ({ t: "try", id, connection }))).tried;
  }

  /** close ends the connection. The worker behind it goes when its port does. */
  close(): void {
    if (this.gone !== undefined) return;
    this.gone = new Error("the engine was closed");
    this.port.post({ t: "close" });
    this.port.close();
    this.refuse(this.gone);
  }

  /**
   * lost is the far end going first: the process behind the port exited, or
   * the socket closed. Every request out is refused, so nothing waits on an
   * answer that cannot come, and it is said once where a client listens for
   * trouble nobody asked about.
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
   * ask sends a request and resolves with its answer, which has to be of the
   * kind `want`: an engine that answers a stat with anything else is one this
   * client cannot read, and is said so rather than read as something it is not.
   * Public for SourceHandle.
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
        if (msg.id !== undefined) {
          // A Refusal again on this side of the port, so what it says is still data.
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

  /** find asks for the next matching row in a column, however far from the band it is. */
  async find(find: FindRequest): Promise<Found> {
    return (await this.engine.ask("found", (id) => ({ t: "find", id, source: this.id, find })))
      .found;
  }
}

/** isKind narrows a reply to one kind, which is how `ask` reads the one it was promised. */
function isKind<K extends Reply["t"]>(reply: Reply, kind: K): reply is Extract<Reply, { t: K }> {
  return reply.t === kind;
}

/** Rows kept around the viewport. Several screens, so a wheel rarely outruns them. */
export const BAND_ROWS = 2000;

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
        this.source.engine.onError(saidOf(err));
      },
    );
  }
}
