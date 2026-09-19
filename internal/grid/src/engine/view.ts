// One source in a workspace: its format, its index, its part of the log, and
// the pages read through them.
//
// Every row that leaves here has been finished through the pipeline, so what a
// client draws is the file with the log applied. The log lives here and nowhere
// else. An edit is one line folded into the Schema and a new generation number:
// no stored row is rewritten, and the rows a client asks for next come back
// changed, wherever in the file they are.

import { trimSpace } from "../go/index.ts";
import { openFormat } from "../ingest/index.ts";
import type { Format } from "../ingest/index.ts";
import { isNumber } from "../num/index.ts";
import { MIN_EXAMPLES, Survey, gather } from "../pattern/index.ts";
import type { Example } from "../pattern/index.ts";
import { describe as describeProgram, text as programText } from "../program/index.ts";
import {
  NO_ROW,
  Op,
  SAMPLE_ROWS,
  Schema,
  finishRows,
  inferKind,
  isDate,
  valueAt,
} from "../sheet/index.ts";
import type { Edit, Written } from "../sheet/index.ts";
import type { ByteSource } from "../store/index.ts";
import { indexPass } from "./pass.ts";
import type {
  Changed,
  ColumnInfo,
  EditRequest,
  FindRequest,
  Found,
  Opened,
  Port,
  Progress,
  Reply,
  Request,
  SourceRef,
} from "./protocol.ts";
import { messageOf } from "./protocol.ts";
import { Pages, RowIndex } from "./rows.ts";
import type { Tuning } from "./rows.ts";

export type OpenSource = (ref: SourceRef) => Promise<ByteSource>;

/** How often a pass posts how far it has got. The status bar needs no more. */
const PROGRESS_MS = 100;

/** How long a pass computes before it lets a waiting request through. */
const SLICE_MS = 8;

type Waiter = () => boolean;

/** A source as a .uno left it: its part of the log, and its bytes where the
 * workspace carried them rather than pointing at the file. */
export interface Carried {
  /** The .uno it came out of, which is what an error about the log blames.
   * Empty where there is none: a file picked to replace a source that lost
   * its own speaks for itself. */
  container: string;
  /** The bytes the container held. Undefined for a source it pointed at, which
   * is read from its own file like any other. */
  raw?: Uint8Array;
  edits: Edit[];
}

/** What a save writes of one source: where its bytes are, its log, and the grid
 * they add up to. Exactly one of `raw` and `path` is set. */
export interface Part {
  raw?: Uint8Array;
  path?: string;
  /** What the file measures, for a save that points at it rather than copying it. */
  bytes: number;
  edits: Edit[];
  rows: number;
  cols: number;
}

export class View {
  opened!: Opened;
  pages!: Pages;
  generation = 0;

  private source!: ByteSource;
  private format!: Format;
  private index!: RowIndex;
  private schema!: Schema;

  /** The source bytes a .uno carried. Undefined for a file read from disk. */
  private carried: Uint8Array | undefined;

  /** Where the file is, so a save can point at it. Empty for bytes with no file
   * behind them, which a save has to carry. */
  readonly path: string;

  private transform = false;
  private survey: AbortController | undefined;
  /** The find running now. A newer one stops it. */
  private finding: AbortController | undefined;
  /** What undo took back, newest last, for redo. A new edit empties it. */
  private undone: Edit[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private waiters: Waiter[] = [];
  private failed: Error | undefined;
  private readonly abort = new AbortController();

  private constructor(
    /** What the workspace and its log call this source. */
    readonly id: string,
    /** The file's name, which `ingest` picks a decoder by. */
    readonly name: string,
    path: string,
    private readonly port: Port<Request, Reply>,
  ) {
    this.path = path;
  }

  /**
   * open starts viewing one source. `source` is the file, or the bytes a .uno
   * carried when `carried` says so. `path` is where the file is, which is what
   * a save points at; bytes with no file behind them pass "". The view owns
   * `source` from here on, and closes it if the open fails.
   */
  static async open(
    id: string,
    name: string,
    path: string,
    source: ByteSource,
    carried: Carried | undefined,
    port: Port<Request, Reply>,
    tuning: Tuning,
  ): Promise<View> {
    const v = new View(id, name, path, port);
    v.carried = carried?.raw;

    // What to blame in an error: the .uno a source came out of, where there is
    // one. A file opened on its own, or picked to replace a source that lost
    // its own, speaks for itself.
    const from = carried === undefined || carried.container === "" ? "" : `${carried.container}: `;

    let format: Format;
    try {
      format = await openFormat(name, source);
    } catch (err) {
      await source.close();
      if (from === "") throw err;
      throw new Error(`${from}${name}: ${messageOf(err)}`);
    }

    v.source = source;
    v.format = format;
    v.index = new RowIndex(format.dataStart, source.size, tuning);
    v.pages = new Pages(name, source, format, v.index, tuning.cacheBytes);
    v.schema = new Schema(format.columns, 0);

    let told = 0;
    let started = false;
    const index = v.index;
    indexPass({
      source,
      format,
      index,
      tuning,
      signal: v.abort.signal,
      progress() {
        v.wake();
        const now = Date.now();
        if (!index.complete && now - told < PROGRESS_MS) return;
        told = now;
        port.post({ t: "progress", source: id, progress: progressOf(index) });
      },
    }).catch((err: unknown) => {
      v.fail(err);
      // Before the open answers, the open fails with it instead.
      if (started) port.post({ t: "error", source: id, message: `${name}: ${messageOf(err)}` });
    });

    try {
      // Kinds come from the first rows, the sample a Sheet reads. A .uno's log
      // names rows by number, and one naming a row the file does not have
      // belongs to a different file, so a log is not replayed until the index
      // has reached the deepest row it names.
      //
      // For bytes the container carried that is the whole of them, which is a
      // moment. For a file the workspace points at it is as far in as the log
      // actually goes: edits near the top of a 30 GB ledger cost a 30 GB
      // ledger's first pages, and nobody waits for the rest.
      const want = Math.max(SAMPLE_ROWS, deepest(carried?.edits));
      const whole = carried?.raw !== undefined;
      await v.until(() => index.complete || (!whole && index.readable() >= want));
      started = true;

      if (carried !== undefined) {
        v.schema.rows = index.complete ? index.counted : index.readable();
        try {
          v.schema.replay(carried.edits);
        } catch (err) {
          throw new Error(`${from}replaying edits to ${name}: ${messageOf(err)}`);
        }
      }

      v.opened = {
        source: id,
        name,
        size: source.size,
        label: format.label,
        columns: await v.columns(),
        progress: progressOf(index),
        edits: carried?.edits ?? [],
        generation: v.generation,
        link: path === "" ? undefined : { path },
      };
      return v;
    } catch (err) {
      await v.close();
      throw err;
    }
  }

  // ------------------------------------------------------------ reading

  /** rows reads rows with the log applied, tagged with the generation they were built at. */
  async rows(
    first: number,
    count: number,
  ): Promise<{ generation: number; rows: string[][]; raws: Array<string[] | null> }> {
    const source = await this.pages.rows(first, count);
    const schema = this.schema;
    const generation = this.generation;

    if (schema.empty) return { generation, rows: source, raws: [] };

    const rows: string[][] = [];
    const raws: Array<string[] | null> = [];
    for (const f of finishRows(schema, first, source)) {
      rows.push(f.shown as string[]);
      raws.push(f.shown === f.raw ? null : (f.raw as string[]));
    }
    return { generation, rows, raws };
  }

  /** columns names each column from the sample, as the log now leaves it. */
  private async columns(): Promise<ColumnInfo[]> {
    const source = await this.pages.rows(0, SAMPLE_ROWS);
    const schema = this.schema;
    const shown = finishRows(schema, 0, source).map((f) => f.shown);

    return schema.headers.map((header, col) => {
      const { kind, flagged } = inferKind(shown.length, (row) => shown[row]![col] ?? "");
      const binding = schema.binding(col);
      return binding === undefined ? { header, kind, flagged } : { header, kind, flagged, binding };
    });
  }

  // ------------------------------------------------------------ changing

  /**
   * mode switches between view and transform. Entering transform loads nothing:
   * it allows edits and starts the recogniser over the log that is already here.
   */
  mode(transform: boolean): void {
    this.transform = transform;
    this.recognise();
  }

  /** edit records one edit. Edits run one at a time, in the order they arrived. */
  edit(req: EditRequest): Promise<Changed> {
    return this.serially(() => this.record(req));
  }

  /**
   * undo takes the last edit back. It is truncate and replay, which is linear in
   * the edits and reads no rows: taking back an apply over 50 million rows costs
   * the length of the log, and the source pages already decoded stay decoded.
   */
  undo(): Promise<Changed> {
    return this.serially(async () => {
      this.refuseInView();
      const edits = this.schema.edits();
      const last = edits.pop();
      if (last === undefined) throw new Error("there is nothing to undo");
      this.schema = Schema.of(this.format.columns, this.schema.rows, edits);
      this.undone.push(last);
      return this.changed(last);
    });
  }

  /**
   * redo records again the edit undo last took back. It is one fold, like any
   * edit. A new edit empties what there was to redo, because the log those
   * edits followed no longer exists.
   */
  redo(): Promise<Changed> {
    return this.serially(async () => {
      this.refuseInView();
      const e = this.undone.pop();
      if (e === undefined) throw new Error("there is nothing to redo");

      const index = this.index;
      this.schema.rows = index.complete ? index.counted : index.readable();
      try {
        this.schema.record(e);
      } catch (err) {
        this.undone.push(e);
        throw err;
      }
      return this.changed(e);
    });
  }

  private async record(req: EditRequest): Promise<Changed> {
    this.refuseInView();

    const index = this.index;
    const schema = this.schema;
    schema.rows = index.complete ? index.counted : index.readable();

    const cell = req.op === Op.Set || req.op === Op.Note;
    const e: Edit = {
      seq: 0,
      op: req.op,
      row: cell ? req.row : NO_ROW,
      col: req.col,
      now: req.now,
    };

    // `was` makes a log line readable on its own, and it is what the recogniser
    // learns from, so it is the value the cell stored as the edit landed.
    const inRange = req.row >= 0 && req.row < schema.rows && req.col >= 0;
    if (cell && inRange && req.col < schema.headers.length) {
      const [row] = await this.pages.rows(req.row, 1);
      e.was = valueAt(schema, req.row, req.col, row ?? []);
    }
    if (req.op === Op.Unbind) {
      const was = schema.binding(req.col);
      if (was !== undefined) e.was = was;
    }

    schema.record(e);
    this.undone = [];
    return this.changed(e);
  }

  private async changed(e: Edit): Promise<Changed> {
    this.generation++;
    this.recognise();
    return { edit: e, generation: this.generation, columns: await this.columns() };
  }

  /** The grid offers editing only in transform, so an edit in view is refused
   * here too rather than trusted. */
  private refuseInView(): void {
    if (!this.transform) throw new Error("the file is in view · Ctrl+E to transform");
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------ recognising

  /**
   * recognise starts the survey again for the log as it now stands. A survey
   * already running is answering a question about a log that no longer exists,
   * so it stops.
   */
  private recognise(): void {
    this.survey?.abort();
    this.survey = undefined;
    const generation = this.generation;

    const byCol = this.transform ? gather(this.schema.edits()) : new Map<number, Example[]>();
    const cols = [...byCol]
      .filter(([, examples]) => examples.length >= MIN_EXAMPLES)
      .map(([col]) => col)
      .sort((a, b) => a - b);

    if (cols.length === 0) {
      this.port.post({ t: "offer", source: this.id, generation, offer: null });
      return;
    }

    const abort = new AbortController();
    this.survey = abort;
    this.surveyColumns(cols, byCol, abort.signal, generation).catch((err: unknown) => {
      if (!abort.signal.aborted) {
        this.port.post({ t: "error", source: this.id, message: messageOf(err) });
      }
    });
  }

  /**
   * surveyColumns reads each column with enough examples, a block at a time,
   * and offers the first question one of them supports.
   *
   * The count grows as it reads, and the client hears about it every
   * PROGRESS_MS. Before the index reaches the end it waits at the frontier
   * rather than guessing.
   */
  private async surveyColumns(
    cols: number[],
    byCol: Map<number, Example[]>,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    const schema = this.schema;
    const index = this.index;

    for (const col of cols) {
      const survey = Survey.start(col, schema.headers[col]!, byCol.get(col)!);
      if (survey === undefined) continue;

      let told = Date.now();
      let slice = Date.now();
      for (let row = 0; ;) {
        await this.until(() => index.complete || index.readable() > row);
        if (signal.aborted) return;
        if (row >= index.readable()) break;

        const block = index.blockOf(row);
        const [from, end] = index.rowsOf(block);
        const records = await this.pages.records(block, false);
        if (signal.aborted) return;

        const values: string[] = [];
        const written: Array<Written | undefined> = [];
        for (let r = row; r < end; r++) {
          values.push(valueAt(schema, r, col, records[r - from]!));
          written.push(schema.writtenIn(r)?.get(col));
        }
        survey.add(values, row, written);
        row = end;

        const now = Date.now();
        if (now - told >= PROGRESS_MS) {
          told = now;
          this.offer(survey, generation, false);
        }
        if (now - slice >= SLICE_MS) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          slice = Date.now();
        }
      }

      if (signal.aborted) return;
      if (survey.proposal() !== undefined) {
        this.offer(survey, generation, true);
        return;
      }
    }
    if (!signal.aborted) this.port.post({ t: "offer", source: this.id, generation, offer: null });
  }

  private offer(survey: Survey, generation: number, complete: boolean): void {
    const p = survey.proposal();
    if (p === undefined) return;
    this.port.post({
      t: "offer",
      source: this.id,
      generation,
      offer: {
        source: this.id,
        col: p.col,
        header: p.header,
        program: programText(p.prog),
        description: describeProgram(p.prog),
        affects: p.affects,
        sample: p.sample,
        ambiguous: p.ambiguous,
        scanned: survey.rows,
        rows: this.index.rows(),
        complete,
      },
    });
  }

  // ------------------------------------------------------------ finding

  /**
   * find looks down or up one column for the next cell that matches, with the
   * log applied. A client's band is a few screens of rows, so anything that
   * looks beyond it runs here, as a pass over the blocks.
   *
   * It searches what the index can serve now rather than waiting for the rest,
   * and says how far it got. A newer find stops an older one: a person who has
   * pressed ]f again has already moved past the first answer.
   */
  async find(req: FindRequest): Promise<Found> {
    this.finding?.abort();
    const abort = new AbortController();
    this.finding = abort;

    const matches = await this.matcher(req);
    if (matches === undefined) return { row: null, searched: 0, complete: true };

    const schema = this.schema;
    const index = this.index;
    const down = req.dir === 1;
    let row = down ? Math.max(0, req.from + 1) : Math.min(index.readable(), req.from) - 1;
    let searched = 0;
    let slice = Date.now();

    while (down ? row < index.readable() : row >= 0) {
      const block = index.blockOf(row);
      const [from, end] = index.rowsOf(block);
      const records = await this.pages.records(block, false);
      if (abort.signal.aborted) return { row: null, searched, complete: false };

      // The block is finished whole, so a bound column is computed once over it
      // rather than once for every row the search steps through.
      const finished = finishRows(schema, from, records);
      for (; down ? row < end : row >= from; row += req.dir) {
        searched++;
        if (matches(finished[row - from]!.shown[req.col] ?? "")) {
          return { row, searched, complete: true };
        }
      }
      if (Date.now() - slice >= SLICE_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        slice = Date.now();
      }
    }
    return { row: null, searched, complete: !down || index.complete };
  }

  /**
   * matcher is the test a find puts to what each cell shows, or undefined when
   * no cell could pass it.
   *
   * Not parsing means what the column's badge means: a date column's cells
   * should be dates, and a numeric one's -- or text flagged as numeric data in a
   * costume -- numbers. A blank is no evidence either way, as the badge reads it.
   */
  private async matcher(req: FindRequest): Promise<((shown: string) => boolean) | undefined> {
    if (req.match.t === "text") {
      const text = req.match.text;
      return text === "" ? undefined : (shown) => shown.includes(text);
    }

    const column = (await this.columns())[req.col];
    if (column === undefined) return undefined;
    const parses =
      column.kind === "date"
        ? isDate
        : column.kind === "num" || column.flagged
          ? isNumber
          : undefined;
    if (parses === undefined) return undefined;
    return (shown) => {
      const v = trimSpace(shown);
      return v !== "" && !parses(v);
    };
  }

  // ------------------------------------------------------------ saving

  /** The file's size: what a save carries, or what it records about what it
   * points at. */
  get size(): number {
    return this.carried?.length ?? this.source.size;
  }

  /** How many bytes a save would have to copy into the container, which for a
   * source with a file behind it is none. */
  get carries(): number {
    return this.path === "" ? this.size : 0;
  }

  /** The log as it stands: what a relink replays over whatever file it is
   * pointed at. */
  get log(): Edit[] {
    return this.schema.edits();
  }

  /** How many edits this source's log holds now. */
  get logged(): number {
    return this.schema.edits().length;
  }

  /**
   * part is what a save writes of this source. It runs in turn with the edits,
   * so the log it hands back is one a save can pair with every other source's.
   *
   * A source with a file behind it is written as that path and read no further.
   * One with no file -- bytes dropped into a browser -- is read whole, because
   * carrying them is the only way to keep them at all.
   *
   * Only a carried source waits for the index. Its bytes are already in memory,
   * so the wait is nothing and the row count in the manifest comes out exact. A
   * pointed-at source reports how far the index has got, and nothing replays
   * against that number, so a save never blocks on a scan of 30 GB.
   */
  part(): Promise<Part> {
    return this.serially(async () => {
      const carry = this.path === "";
      if (carry) await this.until(() => this.index.complete);
      return {
        raw: carry ? (this.carried ?? (await this.source.read(0, this.source.size))) : undefined,
        path: carry ? undefined : this.path,
        bytes: this.size,
        edits: this.schema.edits(),
        rows: this.index.complete ? this.index.counted : this.index.readable(),
        cols: this.schema.headers.length,
      };
    });
  }

  // ------------------------------------------------------------ lifetime

  async close(): Promise<void> {
    this.abort.abort();
    this.survey?.abort();
    this.finding?.abort();
    this.fail(new Error("the file was closed"));
    await this.source.close();
  }

  /** until resolves once ready holds, or rejects if the index fails first. */
  private until(ready: () => boolean): Promise<void> {
    if (this.failed !== undefined) return Promise.reject(this.failed);
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.waiters.push(() => {
        if (this.failed !== undefined) reject(this.failed);
        else if (ready()) resolve();
        else return false;
        return true;
      });
    });
  }

  private wake(): void {
    this.waiters = this.waiters.filter((w) => !w());
  }

  private fail(err: unknown): void {
    this.failed ??= err instanceof Error ? err : new Error(String(err));
    this.wake();
  }
}

/** deepest is one past the last row a log names, and 0 for a log that names
 * none: every operation in it covers a whole column. */
function deepest(edits: readonly Edit[] | undefined): number {
  let row = NO_ROW;
  for (const e of edits ?? []) if (e.row > row) row = e.row;
  return row + 1;
}

function progressOf(index: RowIndex): Progress {
  return {
    done: index.scanned,
    total: index.size,
    readable: index.readable(),
    rows: index.rows(),
    complete: index.complete,
  };
}
