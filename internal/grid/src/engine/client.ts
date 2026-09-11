// The client half: what a renderer holds in place of a sheet.
//
// Engine turns the protocol back into promises. Band is the rows around the
// viewport, the one piece of a file a renderer keeps, and it answers the grid
// synchronously: a row that has not arrived is pending, never awaited.

import type { ColumnInfo, Opened, Port, Progress, Reply, Request, SourceRef } from "./protocol.ts";
import { messageOf } from "./protocol.ts";

interface Waiter<T> {
  resolve(value: T): void;
  reject(err: Error): void;
}

export class Engine {
  /** The latest the engine has said about its index. */
  progress: Progress | undefined;
  onProgress: (progress: Progress) => void = () => {};
  /** A failure nothing was waiting on: the index, or a band request. */
  onError: (message: string) => void = () => {};

  private next = 1;
  private readonly waiting = new Map<number, Waiter<Reply>>();
  private opening: Waiter<Opened> | undefined;
  private closed = false;

  constructor(private readonly port: Port<Reply, Request>) {
    port.listen((msg) => this.receive(msg));
  }

  open(ref: SourceRef): Promise<Opened> {
    return new Promise((resolve, reject) => {
      this.opening = { resolve, reject };
      this.port.post({ t: "open", ref });
    });
  }

  async rows(first: number, count: number): Promise<{ first: number; rows: string[][] }> {
    const r = await this.ask((id) => ({ t: "rows", id, first, count }));
    if (r.t !== "rows") throw new Error(`the engine answered a rows request with ${r.t}`);
    return r;
  }

  /** bytes reads a whole file, refusing one larger than limit. */
  async bytes(ref: SourceRef, limit: number): Promise<Uint8Array> {
    const r = await this.ask((id) => ({ t: "bytes", id, ref, limit }));
    if (r.t !== "bytes") throw new Error(`the engine answered a bytes request with ${r.t}`);
    return r.bytes;
  }

  /** close ends the connection. The worker behind it goes when its port does. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.post({ t: "close" });
    this.port.close();

    const gone = new Error("the engine was closed");
    this.opening?.reject(gone);
    for (const w of this.waiting.values()) w.reject(gone);
    this.waiting.clear();
  }

  private ask(make: (id: number) => Request): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error("the engine was closed"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.port.post(make(id));
    });
  }

  private receive(msg: Reply): void {
    switch (msg.t) {
      case "opened":
        this.progress = msg.opened.progress;
        this.opening?.resolve(msg.opened);
        this.opening = undefined;
        return;

      case "progress":
        this.progress = msg.progress;
        this.onProgress(msg.progress);
        return;

      case "error": {
        const err = new Error(msg.message);
        if (msg.id !== undefined) {
          this.waiting.get(msg.id)?.reject(err);
          this.waiting.delete(msg.id);
        } else if (this.opening !== undefined) {
          this.opening.reject(err);
          this.opening = undefined;
        } else {
          this.onError(msg.message);
        }
        return;
      }

      default:
        this.waiting.get(msg.id)?.resolve(msg);
        this.waiting.delete(msg.id);
    }
  }
}

/** Rows kept around the viewport. Several screens, so a wheel rarely outruns them. */
const BAND_ROWS = 2000;

/**
 * Band is the rows around the viewport.
 *
 * It has the reading half of a Sheet's surface -- `rows`, `cols`, `columns`,
 * `display`, `raw` -- so the grid draws either without knowing which. Every read
 * is an array lookup, as `Sheet.display` is, because the grid calls it for every
 * visible cell on every frame.
 */
export class Band {
  readonly columns: readonly ColumnInfo[];

  private start = 0;
  private data: string[][] = [];
  private asking = false;
  private broken = false;

  constructor(
    private readonly engine: Engine,
    opened: Opened,
    /** Called when rows land, so whoever draws can draw them. */
    private readonly changed: () => void,
  ) {
    this.columns = opened.columns;
  }

  rows(): number {
    return this.engine.progress?.rows ?? 0;
  }

  cols(): number {
    return this.columns.length;
  }

  /** ready reports whether a row has arrived. One that has not is drawn as pending. */
  ready(row: number): boolean {
    return row >= this.start && row < this.start + this.data.length;
  }

  display(row: number, col: number): string {
    return this.raw(row, col);
  }

  raw(row: number, col: number): string {
    return this.data[row - this.start]?.[col] ?? "";
  }

  binding(_col: number): string | undefined {
    return undefined;
  }

  /**
   * view tells the band what is on screen. The grid calls it on every layout,
   * so the usual case compares a few numbers and returns.
   *
   * It asks for a new band when one screen either side of the viewport is not
   * covered, and one request is in flight at most. The reply's `changed` redraws
   * the grid, which calls this again, which is how a viewport that moved while
   * the request was out gets its own.
   */
  view(first: number, count: number): void {
    if (this.asking || this.broken) return;

    const readable = this.engine.progress?.readable ?? 0;
    const lo = Math.max(0, first - count);
    const hi = Math.min(readable, first + 2 * count);
    if (lo >= hi) return;
    if (lo >= this.start && hi <= this.start + this.data.length) return;

    const from = Math.max(
      0,
      Math.min(first + (count >> 1) - (BAND_ROWS >> 1), readable - BAND_ROWS),
    );
    this.asking = true;
    this.engine.rows(from, BAND_ROWS).then(
      (r) => {
        this.asking = false;
        this.start = r.first;
        this.data = r.rows;
        this.changed();
      },
      (err: unknown) => {
        // A block that cannot be read will not be readable on the next frame
        // either. Asking again sixty times a second would say nothing new.
        this.asking = false;
        this.broken = true;
        this.engine.onError(messageOf(err));
      },
    );
  }
}
