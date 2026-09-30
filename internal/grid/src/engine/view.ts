// One source in a workspace: its format, its index, its edit log, and the
// pages read through them.
//
// Every row returned has the log applied. An edit is one line folded into
// the Schema and a new generation number. Every stored row stays as read.

import type { HeldFile, HeldPart, HeldParts } from "../document/index.ts";
import { trimSpace } from "../go/index.ts";
import { headerOf, labelOf, openFormat } from "../ingest/index.ts";
import type { Format } from "../ingest/index.ts";
import { isNumber } from "../num/index.ts";
import { MIN_EXAMPLES, Survey, gather } from "../pattern/index.ts";
import type { Example } from "../pattern/index.ts";
import { described as describedProgram, text as programText } from "../program/index.ts";
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
import { isRemote, multiOf } from "../store/index.ts";
import type { ByteSource, HeaderMode, PartMap, PartsRef, SingleRef } from "../store/index.ts";
import { indexPass } from "./pass.ts";
import type {
  Changed,
  ColumnInfo,
  EditRequest,
  FindRequest,
  Found,
  Link,
  Opened,
  Port,
  Progress,
  Reply,
  Request,
} from "./protocol.ts";
import { FILE_SHOWS, Refusal, saidOf } from "../said/index.ts";
import type { Said } from "../said/index.ts";
import { Pages, RowIndex } from "./rows.ts";
import type { Tuning } from "./rows.ts";
import { BYTES, INDEX, INDEXED, MILLISECONDS, unmeasured } from "./telemetry.ts";
import type { Telemetry } from "./telemetry.ts";

/** Minimum milliseconds between progress messages. */
const PROGRESS_MS = 100;

/** Milliseconds a long loop runs before yielding to the event loop. */
const SLICE_MS = 8;

/**
 * The header of the column that names each row's file, in a source over
 * several files that asked for one.
 */
export const FILE_COLUMN = "_file";

type Waiter = () => boolean;

/** Run is a run of a block's rows that came from one part. */
interface Run {
  /** The first row of the run, counting from 0 at the block's first. */
  row: number;
  /** Which part, counting from 0. */
  part: number;
}

/**
 * Crossing caches the runs of a block that holds rows from more than one
 * part. It is valid for the map and byte range it was computed from.
 */
interface Crossing {
  map: PartMap;
  start: number;
  end: number;
  runs: Run[];
}

/** A source's edits and, for a carried source, its bytes, as read from a
 * .uno. */
export interface Carried {
  /** The .uno it came from, named in log errors. Empty when there is none. */
  container: string;
  /** The bytes the container held. Undefined for a pointed-at source. */
  raw?: Uint8Array;
  edits: Edit[];
}

/**
 * Part is what a save writes of one source, plus its edits. It omits the
 * id, name and state, which the workspace adds. `parts` is present for a
 * source over several files.
 */
export type Part = (Omit<HeldFile, Unsaved> | Omit<HeldParts, Unsaved>) & { edits: Edit[] };
type Unsaved = "id" | "name" | "state";

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

  /** The file's path. Empty for carried bytes, and for a source over several
   * files. */
  readonly path: string;

  /** The id of the connection the file was read through, if any. */
  connection: string | undefined;

  /** The parts ref a source over several files was opened from. */
  parts: PartsRef | undefined;

  /** Cached runs for blocks that hold rows from more than one part. */
  private readonly crossings = new Map<number, Crossing>();

  private transform = false;
  private survey: AbortController | undefined;
  /** The find running now. A newer find aborts it. */
  private finding: AbortController | undefined;
  /** Edits undo took back, newest last, for redo. A new edit empties it. */
  private undone: Edit[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private waiters: Waiter[] = [];
  private failed: Error | undefined;
  private readonly abort = new AbortController();

  private constructor(
    /** The source's id in the workspace and its log. */
    readonly id: string,
    /** The file's name. `ingest` picks a decoder by it. */
    readonly name: string,
    path: string,
    private readonly port: Port<Request, Reply>,
  ) {
    this.path = path;
  }

  /**
   * open detects the format, starts indexing, waits for the sample rows,
   * replays any carried edits, and returns the view.
   *
   * `path` is "" for carried bytes. The view owns `source`
   * from here on and closes it if the open fails. `header` says whether the
   * first line names the columns. `parts` is set for a source over several
   * files.
   */
  static async open(
    id: string,
    name: string,
    path: string,
    source: ByteSource,
    carried: Carried | undefined,
    port: Port<Request, Reply>,
    tuning: Tuning,
    telemetry: Telemetry = unmeasured,
    header: HeaderMode = "first",
    parts?: PartsRef,
  ): Promise<View> {
    const v = new View(id, name, path, port);
    v.carried = carried?.raw;
    v.parts = parts;

    // Errors for a source from a .uno name the .uno as well.
    const container = carried === undefined ? "" : carried.container;
    const within = (why: Said): Said =>
      container === "" ? why : { t: "about", subject: container, why };

    let format: Format;
    try {
      format = await openFormat(name, source, header);
    } catch (err) {
      await source.close();
      if (container === "") throw err;
      throw new Refusal(within({ t: "about", subject: name, why: saidOf(err) }));
    }

    v.source = source;
    v.format = format;
    v.index = new RowIndex(format.dataStart, source.size, tuning);
    v.pages = new Pages(name, source, format, v.index, tuning.cacheBytes);
    v.schema = schemaOf(format, parts);

    let told = 0;
    let started = false;
    const index = v.index;
    const began = performance.now();
    // The telemetry attribute for where the bytes came from.
    const place =
      carried?.raw !== undefined
        ? "carried"
        : path === ""
          ? "joined"
          : isRemote(path)
            ? "bucket"
            : "disk";
    indexPass({
      source,
      format,
      index,
      tuning,
      signal: v.abort.signal,
      progress() {
        v.wake();
        if (index.complete) {
          const attributes = { place };
          telemetry({
            name: INDEX,
            kind: "duration",
            unit: MILLISECONDS,
            value: performance.now() - began,
            attributes,
          });
          telemetry({ name: INDEXED, kind: "count", unit: BYTES, value: source.size, attributes });
        }
        const now = Date.now();
        if (!index.complete && now - told < PROGRESS_MS) return;
        told = now;
        port.post({ t: "progress", source: id, progress: progressOf(index) });
      },
    }).catch((err: unknown) => {
      v.fail(err);
      // Before open returns, the failure is thrown from open instead. After
      // a close, the abort is the cause and the failure is swallowed.
      if (started && !v.abort.signal.aborted) {
        port.post({
          t: "error",
          source: id,
          said: { t: "about", subject: name, why: saidOf(err) },
        });
      }
    });

    try {
      // Wait until the index covers the sample rows and the deepest row the
      // carried edits name. Carried bytes wait for the whole index.
      const want = Math.max(SAMPLE_ROWS, deepest(carried?.edits));
      const whole = carried?.raw !== undefined;
      await v.until(() => index.complete || (!whole && index.readable() >= want));
      started = true;

      if (carried !== undefined) {
        v.schema.rows = index.readable();
        try {
          v.schema.replay(carried.edits);
        } catch (err) {
          throw new Refusal(within({ t: "replaying", name, why: saidOf(err) }));
        }
      }

      v.opened = {
        source: id,
        name,
        size: source.size,
        label: labelOf(format),
        columns: await v.columns(),
        progress: progressOf(index),
        edits: carried?.edits ?? [],
        generation: v.generation,
        link: path === "" ? undefined : linkTo(path, source.version),
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
    const files = await this.files(Math.max(0, first), source.length);
    const schema = this.schema;
    const generation = this.generation;

    if (schema.empty && files === undefined) return { generation, rows: source, raws: [] };

    const rows: string[][] = [];
    const raws: Array<string[] | null> = [];
    for (const f of finishRows(schema, first, source, files)) {
      rows.push(f.shown as string[]);
      raws.push(f.shown === f.raw ? null : (f.raw as string[]));
    }
    return { generation, rows, raws };
  }

  /** columns infers each column's kind from the sample rows, with the log applied. */
  private async columns(): Promise<ColumnInfo[]> {
    const source = await this.pages.rows(0, SAMPLE_ROWS);
    const files = await this.files(0, source.length);
    const schema = this.schema;
    const shown = finishRows(schema, 0, source, files).map((f) => f.shown);

    return schema.headers.map((header, col) => {
      const { kind, flagged } = inferKind(shown.length, (row) => shown[row]![col] ?? "");
      const binding = schema.binding(col);
      return binding === undefined ? { header, kind, flagged } : { header, kind, flagged, binding };
    });
  }

  /**
   * files returns the `_file` cell for each of `count` rows from `first`:
   * the name of the part holding the row's first byte. Undefined for a
   * source that lacks the column.
   */
  private async files(first: number, count: number): Promise<string[] | undefined> {
    if (this.schema.supplied === undefined) return undefined;
    const ref = this.parts;
    const multi = multiOf(this.source);
    if (ref === undefined || multi === undefined) {
      throw new Refusal({ t: "joins-unknown-for-column", name: this.name });
    }

    const names: string[] = [];
    const end = first + count;
    for (let row = first; row < end;) {
      const block = this.index.blockOf(row);
      const [from, to] = this.index.rowsOf(block);
      const runs = await this.runsIn(block, multi.map);
      for (let run = 0; row < Math.min(to, end); row++) {
        while (run + 1 < runs.length && runs[run + 1]!.row <= row - from) run++;
        names.push(ref.parts[runs[run]!.part]?.ref.name ?? "");
      }
    }
    return names;
  }

  /**
   * runsIn returns which part each row of a block came from, as runs.
   *
   * A block inside one part is one run. A block that crosses a part boundary
   * is re-read up to its last part and scanned for row starts, and the
   * result is cached.
   */
  private async runsIn(block: number, map: PartMap): Promise<Run[]> {
    const [start, end] = this.index.bytesOf(block);
    const first = map.partAt(start);
    const last = map.partAt(end - 1);
    if (first === undefined || last === undefined) {
      throw new Refusal({ t: "rows-past-files", name: this.name });
    }
    if (first === last) return [{ row: 0, part: first }];

    const known = this.crossings.get(block);
    if (known !== undefined && known.map === map && known.start === start && known.end === end) {
      return known.runs;
    }

    // Rows from the last part's first byte on belong to it, so only the
    // bytes before it are scanned.
    const until = map.spans[last]!.start;
    const runs: Run[] = [];
    let row = 0;
    const scanner = this.format.scanner((offset) => {
      const part = map.partAt(offset)!;
      if (runs.at(-1)?.part !== part) runs.push({ row, part });
      row++;
    });
    scanner.push(await this.source.read(start, until - start), start);
    runs.push({ row, part: last });

    this.crossings.set(block, { map, start, end, runs });
    return runs;
  }

  // ------------------------------------------------------------ changing

  /**
   * mode switches between view and transform, and restarts the recogniser.
   */
  mode(transform: boolean): void {
    this.transform = transform;
    this.recognise();
  }

  /** edit records one edit. Edits run one at a time, in arrival order. */
  edit(req: EditRequest): Promise<Changed> {
    return this.serially(() => this.record(req));
  }

  /**
   * undo takes the last edit back by rebuilding the schema from the edits
   * before it. It touches the schema alone.
   */
  undo(): Promise<Changed> {
    return this.serially(async () => {
      this.refuseInView();
      const edits = this.schema.edits();
      const last = edits.pop();
      if (last === undefined) throw new Refusal({ t: "nothing-to-undo" });
      const was = this.schema;
      this.schema = Schema.of(was.headers, was.rows, edits, was.supplied);
      this.undone.push(last);
      return this.changed(last);
    });
  }

  /**
   * redo records again the edit undo last took back.
   */
  redo(): Promise<Changed> {
    return this.serially(async () => {
      this.refuseInView();
      const e = this.undone.pop();
      if (e === undefined) throw new Refusal({ t: "nothing-to-redo" });

      this.schema.rows = this.index.readable();
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
    schema.rows = index.readable();

    const cell = req.op === Op.Set || req.op === Op.Note;
    const e: Edit = {
      seq: 0,
      op: req.op,
      row: cell ? req.row : NO_ROW,
      col: req.col,
      now: req.now,
    };

    // `was` is the value the cell stored before the edit. The recogniser
    // learns from it.
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

  /** refuseInView throws while the view is in view mode. */
  private refuseInView(): void {
    if (!this.transform) throw new Refusal({ t: "in-view" });
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------ recognising

  /**
   * recognise aborts any running survey and starts a new one over the
   * current log. In view mode it posts a null offer.
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
        this.port.post({ t: "error", source: this.id, said: saidOf(err) });
      }
    });
  }

  /**
   * surveyColumns reads each column with enough examples, a block at a
   * time, and posts the first proposal one of them supports. Partial offers
   * are posted every PROGRESS_MS. It waits for the index to reach each row
   * before reading it.
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
        if (now - slice >= SLICE_MS) slice = await turn();
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
        description: describedProgram(p.prog),
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
   * find searches down or up one column for the next matching cell, with
   * the log applied. It searches only the readable rows and reports how far
   * it got. A newer find aborts an older one.
   */
  async find(req: FindRequest): Promise<Found> {
    this.finding?.abort();
    const abort = new AbortController();
    this.finding = abort;

    const matches = await this.matcher(req);
    if (matches === undefined) return { row: null, searched: 0, complete: true };

    const index = this.index;
    const down = req.dir === 1;
    let row = down ? Math.max(0, req.from + 1) : Math.min(index.readable(), req.from) - 1;
    let searched = 0;
    let slice = Date.now();

    while (down ? row < index.readable() : row >= 0) {
      const block = index.blockOf(row);
      const [from, end] = index.rowsOf(block);
      const records = await this.pages.records(block, false);
      const files = await this.files(from, records.length);
      if (abort.signal.aborted) return { row: null, searched, complete: false };

      // Only the searched column is finished.
      const shown = this.shownIn(req.col, from, records, files);
      for (; down ? row < end : row >= from; row += req.dir) {
        searched++;
        if (matches(shown(row))) return { row, searched, complete: true };
      }
      if (Date.now() - slice >= SLICE_MS) slice = await turn();
    }
    return { row: null, searched, complete: !down || index.complete };
  }

  /**
   * shownIn returns a function giving what one column of a block shows for
   * a row, as `finishRows` would.
   *
   * A formula column finishes the whole block once, since it reads other
   * columns. A plain column is read a cell at a time: a note's rendering,
   * the file name for the supplied column, or the stored value.
   */
  private shownIn(
    col: number,
    from: number,
    records: readonly (readonly string[])[],
    files: readonly string[] | undefined,
  ): (row: number) => string {
    const schema = this.schema;
    if (schema.formula(col) !== undefined) {
      const finished = finishRows(schema, from, records, files);
      return (row) => finished[row - from]!.shown[col] ?? "";
    }
    if (schema.supplied?.col === col) {
      return (row) => schema.writtenIn(row)?.get(col)?.rendered ?? files?.[row - from] ?? "";
    }
    return (row) =>
      schema.writtenIn(row)?.get(col)?.rendered ?? valueAt(schema, row, col, records[row - from]!);
  }

  /**
   * matcher returns the test a find applies to each cell's shown value, or
   * undefined for a request with zero possible matches.
   *
   * An "unparsed" match tests a date column with isDate and a numeric or
   * flagged column with isNumber. A blank cell is skipped.
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

  /** The size of the carried bytes, or of the source. */
  get size(): number {
    return this.carried?.length ?? this.source.size;
  }

  /** The version the source was read at, where the store reports one.
   * Undefined for a carried source and a source over several files. */
  get version(): string | undefined {
    return this.path === "" ? undefined : this.source.version;
  }

  /** Bytes a save would copy into the container: the size for a carried
   * source, otherwise 0. */
  get carries(): number {
    return this.path === "" && this.parts === undefined ? this.size : 0;
  }

  /** The current edit log. */
  get log(): Edit[] {
    return this.schema.edits();
  }

  /** The number of edits in the log. */
  get logged(): number {
    return this.schema.edits().length;
  }

  /**
   * part returns what a save writes of this source. It runs in the edit
   * queue, so its log is consistent with the other sources.
   *
   * A source with a path is written as the path. A source over several
   * files is written as its parts. A carried source is read whole and
   * written as its bytes; only that case waits for the index to complete.
   */
  part(): Promise<Part> {
    return this.serially(async () => {
      if (this.parts !== undefined) {
        return { ...(await this.joined(this.parts)), connection: this.connection, ...this.kept() };
      }
      const carry = this.path === "";
      if (carry) await this.until(() => this.index.complete);
      return {
        raw: carry ? (this.carried ?? (await this.source.read(0, this.source.size))) : undefined,
        path: carry ? undefined : this.path,
        bytes: this.size,
        version: this.version,
        connection: carry ? undefined : this.connection,
        ...this.kept(),
      };
    });
  }

  /** kept returns the edits and the row and column counts they were made over. */
  private kept(): Pick<Part, "edits" | "rows" | "cols"> {
    return {
      edits: this.schema.edits(),
      rows: this.index.readable(),
      cols: this.schema.headers.length,
    };
  }

  /**
   * joined returns what a save writes of the parts: each part's path,
   * version, and measured extent. A part is refused by name when its path is
   * empty.
   */
  private async joined(
    ref: PartsRef,
  ): Promise<{ parts: HeldPart[]; header: HeaderMode; fileColumn?: boolean }> {
    const count = ref.parts.length;
    const multi = multiOf(this.source);
    if (multi === undefined) {
      throw new Refusal({ t: "joins-unknown-for-save", name: this.name, count });
    }

    const files = ref.parts.map(({ ref: file }, i) => {
      if (!("path" in file)) {
        throw new Refusal({
          t: "part-has-no-path",
          name: this.name,
          file: file.name,
          part: i + 1,
          count,
        });
      }
      return file;
    });

    // versions() opens any part still unread. If that fails, the parts keep
    // the versions they were opened by.
    const versions = await multi.versions().catch(() => files.map((file) => file.version));

    return {
      parts: files.map((file, i) => {
        const extent = multi.extents[i]!;
        return {
          name: file.name,
          path: file.path,
          bytes: extent.bytes,
          version: versions[i],
          skip: extent.skip,
          unterminated: extent.unterminated,
        };
      }),
      header: ref.header,
      // Only the choice is saved. The column's values are recomputed on open.
      fileColumn: ref.fileColumn === true ? true : undefined,
    };
  }

  /**
   * extended returns this source's parts ref with `files` appended, or
   * undefined for a single-file source. Each existing part carries the
   * extent the join measured, so every row keeps its number.
   */
  extended(files: readonly SingleRef[]): PartsRef | undefined {
    const ref = this.parts;
    if (ref === undefined) return undefined;
    const extents = multiOf(this.source)?.extents;
    return {
      ...ref,
      parts: [
        ...ref.parts.map((part, i) => {
          const extent = extents?.[i];
          return extent === undefined ? part : { ...part, extent };
        }),
        ...files.map((file) => ({ ref: file })),
      ],
    };
  }

  // ------------------------------------------------------------ lifetime

  async close(): Promise<void> {
    this.abort.abort();
    this.survey?.abort();
    this.finding?.abort();
    this.fail(new Refusal({ t: "file-closed" }));
    await this.source.close();
  }

  /** until resolves once `ready` returns true, or rejects if the index fails first. */
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

/**
 * schemaOf builds an empty schema over the file's columns, plus a `_file`
 * column at the end when the parts ref asks for one. The header is
 * deduplicated, so an existing `_file` column keeps its name and the added
 * one takes a suffix.
 */
function schemaOf(format: Format, parts: PartsRef | undefined): Schema {
  if (parts?.fileColumn !== true) return new Schema(format.columns, 0);
  return new Schema(headerOf([...format.columns, FILE_COLUMN]), 0, {
    col: format.columns.length,
    shows: FILE_SHOWS,
  });
}

/** deepest returns one past the highest row the edits name, or 0 when none
 * names a row. */
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

/** linkTo builds a Link from a path and an optional version. */
function linkTo(path: string, version: string | undefined): Link {
  return version === undefined ? { path } : { path, version };
}

/**
 * turn yields to the event loop once and returns the current time, which is
 * when the next slice starts.
 */
async function turn(): Promise<number> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return Date.now();
}
