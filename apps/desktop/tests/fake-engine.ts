/**
 * @fileoverview A fake engine to boot the real shell over. It stands where the
 * engine's port would, opens one source whatever it is asked to open, serves
 * its rows at the generation it is at, takes every edit, and finds columns
 * when a test says so. It keeps every request it is sent, so a test reads
 * what the shell asked.
 */

import type { ColumnInfo, EditRequest, MessagePortLike, Reply, Request } from "@engine";

/** The source it opens, by id and by name. */
export const FAKE_SOURCE = "events";
export const FAKE_NAME = "events.jsonl";
/** The rows the source holds, every one of them readable. */
export const FAKE_ROWS = 40;

/** cellAt returns what the fake engine shows in a column's row. */
export function cellAt(column: ColumnInfo, row: number): string {
  return `${column.header} ${row + 1}`;
}

/** FakeEngine is a port the shell talks to as it would to an engine's. */
export class FakeEngine implements MessagePortLike {
  readonly asked: Request[] = [];
  private heard: (e: { data: unknown }) => void = () => {};
  private generation = 0;

  constructor(private columns: ColumnInfo[]) {}

  /** The edits it was sent, as the client sent them. */
  get edits(): EditRequest[] {
    return this.asked.flatMap((r) => (r.t === "edit" ? [r.edit] : []));
  }

  postMessage(msg: unknown): void {
    const request = msg as Request;
    this.asked.push(request);
    this.answer(request);
  }

  addEventListener(type: "message" | "close", fn: (e: { data: unknown }) => void): void {
    if (type === "message") this.heard = fn;
  }

  start(): void {}

  close(): void {}

  /**
   * widen says the source found columns as it was indexed: `columns` is
   * every column it has now. Rows built before are stale.
   */
  widen(columns: ColumnInfo[]): void {
    this.columns = columns;
    this.generation++;
    this.say({ t: "widened", source: FAKE_SOURCE, generation: this.generation, columns });
  }

  /** say hands `reply` to the client on a later turn, as a port does. */
  private say(reply: Reply): void {
    setTimeout(() => this.heard({ data: reply }));
  }

  private answer(request: Request): void {
    const { columns, generation } = this;
    if (request.t === "open") {
      const progress = {
        done: 1,
        total: 1,
        readable: FAKE_ROWS,
        rows: FAKE_ROWS,
        complete: false,
        elapsedMs: 0,
      };
      const opened = { source: FAKE_SOURCE, name: FAKE_NAME, size: 1, columns, progress };
      const added = { opened: [{ ...opened, edits: [], generation }], showing: FAKE_SOURCE };
      this.say({ t: "opened", id: request.id, added });
    } else if (request.t === "rows") {
      const count = Math.max(0, Math.min(request.count, FAKE_ROWS - request.first));
      const rows = Array.from({ length: count }, (_, i) =>
        columns.map((column) => cellAt(column, request.first + i)),
      );
      const raws = rows.map(() => null);
      this.say({ t: "rows", id: request.id, first: request.first, generation, rows, raws });
    } else if (request.t === "edit") {
      this.generation++;
      const edit = { ...request.edit, seq: this.generation };
      const changed = { edit, generation: this.generation, columns };
      this.say({ t: "changed", id: request.id, source: FAKE_SOURCE, changed });
    }
  }
}
