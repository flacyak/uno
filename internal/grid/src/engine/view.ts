// The file being viewed: its format, its index, the log over it, and the pages
// read through them.
//
// Every row that leaves here has been finished through the pipeline, so what a
// client draws is the file with the log applied. The log lives here and nowhere
// else. An edit is one line folded into the Schema and a new generation number:
// no stored row is rewritten, and the rows a client asks for next come back
// changed, wherever in the file they are.

import { newManifest, readContainer, writeDocument } from "../document/index.ts";
import type { Cell, Document } from "../document/index.ts";
import { openFormat } from "../ingest/index.ts";
import type { Format } from "../ingest/index.ts";
import { MIN_EXAMPLES, Survey, gather } from "../pattern/index.ts";
import type { Example } from "../pattern/index.ts";
import { describe as describeProgram, text as programText } from "../program/index.ts";
import { NO_ROW, Op, SAMPLE_ROWS, Schema, finish, inferKind, valueAt } from "../sheet/index.ts";
import type { Edit } from "../sheet/index.ts";
import type { ByteSource } from "../store/index.ts";
import { bytesSource } from "../store/index.ts";
import { indexPass } from "./pass.ts";
import type {
  Changed,
  ColumnInfo,
  EditRequest,
  Opened,
  Port,
  Progress,
  Reply,
  Request,
  SourceRef,
} from "./protocol.ts";
import { formatBytes, messageOf } from "./protocol.ts";
import { Pages, RowIndex } from "./rows.ts";
import type { Tuning } from "./rows.ts";

export type OpenSource = (ref: SourceRef) => Promise<ByteSource>;

/** How often a pass posts how far it has got. The status bar needs no more. */
const PROGRESS_MS = 100;

/** How long a pass computes before it lets a waiting request through. */
const SLICE_MS = 8;

/**
 * The largest .uno read whole. It is the same ceiling saving embeds a source
 * under, so any file this build wrote opens again.
 */
export const WHOLE_LIMIT = 256 << 20;

type Waiter = () => boolean;

export class View {
  opened!: Opened;
  pages!: Pages;
  generation = 0;

  private name = "";
  private source!: ByteSource;
  private format!: Format;
  private index!: RowIndex;
  private schema!: Schema;

  /** What a .uno was saved with, kept for the next save. */
  private doc: Document | undefined;
  /** The source bytes a .uno carried. Undefined for a file read from disk. */
  private carried: Uint8Array | undefined;

  private transform = false;
  private survey: AbortController | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private waiters: Waiter[] = [];
  private failed: Error | undefined;
  private readonly abort = new AbortController();

  private constructor(private readonly port: Port<Request, Reply>) {}

  static async open(
    ref: SourceRef,
    openSource: OpenSource,
    port: Port<Request, Reply>,
    tuning: Tuning,
  ): Promise<View> {
    const v = new View(port);
    let source = await openSource(ref);
    let name = ref.name;

    // A .uno is a zip, and its source has to come out of it before anything can
    // index it. It was written from memory, so it is read into memory.
    if (ref.name.toLowerCase().endsWith(".uno")) {
      let bytes: Uint8Array;
      try {
        if (source.size > WHOLE_LIMIT) {
          throw new Error(
            `${ref.name} is ${formatBytes(source.size)}, over the ${formatBytes(WHOLE_LIMIT)} a workspace can be read whole`,
          );
        }
        bytes = await source.read(0, source.size);
      } finally {
        await source.close();
      }
      v.doc = readContainer(ref.name, bytes);
      v.carried = v.doc.raw;
      name = v.doc.manifest.source.name;
      source = bytesSource(v.doc.raw);
    }

    let format: Format;
    try {
      format = await openFormat(name, source);
    } catch (err) {
      await source.close();
      if (v.doc === undefined) throw err;
      throw new Error(`${ref.name}: embedded ${name}: ${messageOf(err)}`);
    }

    v.name = name;
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
        port.post({ t: "progress", progress: progressOf(index) });
      },
    }).catch((err: unknown) => {
      v.fail(err);
      // Before the open answers, the open fails with it instead.
      if (started) port.post({ t: "error", message: `${name}: ${messageOf(err)}` });
    });

    try {
      // Kinds come from the first rows, the sample a Sheet reads. A .uno's log
      // names rows by number, and one naming a row the source does not have
      // belongs to another file, so a .uno is indexed to the end first. Its
      // source is in memory, which makes that a moment.
      const doc = v.doc;
      await v.until(() => index.complete || (doc === undefined && index.readable() >= SAMPLE_ROWS));
      started = true;

      if (doc !== undefined) {
        v.schema.rows = index.counted;
        try {
          v.schema.replay(doc.edits);
        } catch (err) {
          throw new Error(`${ref.name}: replaying edits: ${messageOf(err)}`);
        }
      }

      v.opened = {
        name,
        size: source.size,
        label: format.label,
        columns: await v.columns(),
        progress: progressOf(index),
        edits: doc?.edits ?? [],
        generation: v.generation,
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
    for (let i = 0; i < source.length; i++) {
      const f = finish(schema, first + i, source[i]!);
      rows.push(f.shown as string[]);
      raws.push(f.shown === f.raw ? null : (f.raw as string[]));
    }
    return { generation, rows, raws };
  }

  /** columns names each column from the sample, as the log now leaves it. */
  private async columns(): Promise<ColumnInfo[]> {
    const source = await this.pages.rows(0, SAMPLE_ROWS);
    const schema = this.schema;
    const shown = source.map((row, i) => finish(schema, i, row).shown);

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
      return this.changed(last);
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
    if (!this.transform) throw new Error("the file is in view · i or Ctrl+E to transform");
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
      this.port.post({ t: "offer", generation, offer: null });
      return;
    }

    const abort = new AbortController();
    this.survey = abort;
    this.surveyColumns(cols, byCol, abort.signal, generation).catch((err: unknown) => {
      if (!abort.signal.aborted) this.port.post({ t: "error", message: messageOf(err) });
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
        for (let r = row; r < end; r++) values.push(valueAt(schema, r, col, records[r - from]!));
        survey.add(values, row);
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
    if (!signal.aborted) this.port.post({ t: "offer", generation, offer: null });
  }

  private offer(survey: Survey, generation: number, complete: boolean): void {
    const p = survey.proposal();
    if (p === undefined) return;
    this.port.post({
      t: "offer",
      generation,
      offer: {
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

  // ------------------------------------------------------------ saving

  /**
   * save writes the workspace as a .uno: the source, embedded, and the log.
   *
   * Embedding is the only layout this build writes, so a source over `limit`
   * is refused by name. Format 4 lifts that by pointing at the file instead.
   */
  save(active: Cell, limit: number): Promise<Uint8Array> {
    return this.serially(async () => {
      const size = this.carried?.length ?? this.source.size;
      if (size > limit) {
        throw new Error(
          `${this.name} is ${formatBytes(size)}, and a .uno can carry ${formatBytes(limit)} of its source until it can point at the file instead`,
        );
      }

      // The manifest records the row count, which is exact only at the end.
      await this.until(() => this.index.complete);

      const doc = (this.doc ??= {
        manifest: newManifest(this.name),
        raw: new Uint8Array(0),
        state: { active },
        edits: [],
        extra: new Map(),
      });
      doc.raw = this.carried ?? (await this.source.read(0, this.source.size));
      doc.edits = this.schema.edits();
      doc.state.active = active;
      doc.manifest.sheet.rows = this.index.counted;
      doc.manifest.sheet.cols = this.schema.headers.length;

      const bytes = writeDocument(doc);
      // A source read from disk is read again at the next save rather than
      // held between saves.
      if (this.carried === undefined) doc.raw = new Uint8Array(0);
      return bytes;
    });
  }

  // ------------------------------------------------------------ lifetime

  async close(): Promise<void> {
    this.abort.abort();
    this.survey?.abort();
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

function progressOf(index: RowIndex): Progress {
  return {
    done: index.scanned,
    total: index.size,
    readable: index.readable(),
    rows: index.rows(),
    complete: index.complete,
  };
}
