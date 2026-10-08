// One source in a workspace: its format, its index, its part of the log, and
// the pages read through them.
//
// Every row that leaves here has been finished through the pipeline, so what a
// client draws is the file with the log applied. The log lives here and nowhere
// else. An edit is one line folded into the Schema and a new generation number:
// no stored row is rewritten, and the rows a client asks for next come back
// changed, wherever in the file they are.

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

/** How often a pass posts how far it has got. The status bar needs no more. */
const PROGRESS_MS = 100;

/** How long a pass computes before it lets a waiting request through. */
const SLICE_MS = 8;

/**
 * What the column saying which file each row came from is headed, in a source
 * of several files that asked for one.
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
 * Crossing is the runs of a block that holds rows of more than one part,
 * kept because finding them reads the block's bytes a second time. It is
 * good for the bytes and the map it was found in, and found again for others.
 */
interface Crossing {
  map: PartMap;
  start: number;
  end: number;
  runs: Run[];
}

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

/**
 * Part is what a save writes of one source: what a workspace holds of it, less
 * what the workspace gives it -- its id, its name, where its grid was left --
 * and with its log. The bytes are one file or several read as one, and `parts`
 * is what says which.
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

  /** Where the file is, so a save can point at it. Empty for bytes with no file
   * behind them, which a save has to carry. */
  readonly path: string;

  /** The id of the connection the file was read through, when one covered it. */
  connection: string | undefined;

  /**
   * The parts it was opened from, for a source that is several files read as
   * one. Such a source has files behind it and no one path to them, so `path`
   * is empty and this is what says where its bytes are.
   */
  parts: PartsRef | undefined;

  /** Where the parts change in each block read so far that more than one has
   * rows in. */
  private readonly crossings = new Map<number, Crossing>();

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
   * `source` from here on, and closes it if the open fails. `telemetry` is
   * told how long the index took once it has finished. `header` says whether
   * the first line names the columns, which it does unless the source was
   * added as having no header row. `parts` is the files `source` joins, for
   * several read as one, and says whether they are shown a `_file` column.
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

    // What to blame in an error: the .uno a source came out of, where there is
    // one. A file opened on its own, or picked to replace a source that lost
    // its own, speaks for itself.
    // What goes wrong reading a source a .uno carried is said of the .uno too.
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
    // Where the bytes are, and nothing about whose they are.
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
      // Before the open answers, the open fails with it instead. A view that
      // was closed has nothing to report: its close is what cut the read short.
      if (started && !v.abort.signal.aborted) {
        port.post({
          t: "error",
          source: id,
          said: { t: "about", subject: name, why: saidOf(err) },
        });
      }
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

  /** columns names each column from the sample, as the log now leaves it. */
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
   * files is the `_file` cell of each of `count` readable rows from `first`:
   * the name of the part the row's first byte is in. Undefined for a source
   * that shows no such column.
   *
   * It is asked of the parts and the map as they are when the rows are read,
   * and no cell of it is kept.
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
   * runsIn says which part each row of a block came from, as runs of rows.
   *
   * Nearly every block lies inside one part, and where it starts says which
   * with nothing read. A block that holds a boundary is read again as far as
   * its last part and scanned for where its rows start, since the index keeps
   * an offset for a block and none for a row.
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

    // Every row from the last part's first byte on is that part's, so only
    // the rows before it are looked for.
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
      if (last === undefined) throw new Refusal({ t: "nothing-to-undo" });
      const was = this.schema;
      this.schema = Schema.of(was.headers, was.rows, edits, was.supplied);
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
    if (!this.transform) throw new Refusal({ t: "in-view" });
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
        this.port.post({ t: "error", source: this.id, said: saidOf(err) });
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

      // Only the column searched is finished: a find reads one cell of each
      // row, and the formulas bound to the other columns are none of its
      // concern.
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
   * shownIn is what one column of a block shows, row by row, as `finishRows`
   * would leave it, without finishing the rest of the block.
   *
   * A column nothing computes is finished a cell at a time: what the cell
   * stores, or a note's rendering of it, and for the supplied column the name
   * of the row's file. A bound column reads the others, so a block of it is
   * finished whole, once, rather than once for every row the search steps
   * through.
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

  /** Which bytes of the file were read, where the place it is in can say.
   * Undefined for bytes a save carries, which are their own version. */
  get version(): string | undefined {
    return this.path === "" ? undefined : this.source.version;
  }

  /** How many bytes a save would have to copy into the container, which for a
   * source with a file behind it is none. */
  get carries(): number {
    return this.path === "" && this.parts === undefined ? this.size : 0;
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
   *
   * Several files read as one are written as their parts, each pointed at:
   * carrying the join in their place would save a different source from the
   * one that is open.
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

  /** kept is what a save writes down of the log, whatever the bytes are: the edits, and the shape they were made over. */
  private kept(): Pick<Part, "edits" | "rows" | "cols"> {
    return {
      edits: this.schema.edits(),
      rows: this.index.readable(),
      cols: this.schema.headers.length,
    };
  }

  /**
   * joined is what a save writes of the parts this source was opened from:
   * each part's path, the version it was read as, and the extent the join
   * measured of it, which is what lets the next open place every part without
   * opening one.
   *
   * Every part has to have a path. A part dropped into a browser has none, and
   * the save is refused naming it: a .uno points at parts and has no way to
   * carry one, and writing the others down without it would save a different
   * table from the one that is open.
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

    // Asking opens any part no read has reached yet. One that will not open
    // now -- moved, or no longer the file the log was made against -- must not
    // cost the save, so the parts then keep the versions they were opened by:
    // a part a read did reach was held to its own, and one no read reached has
    // nothing newer to say.
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
      // The choice is part of what the source is. What the column shows is
      // worked out from the parts again, so none of it is written.
      fileColumn: ref.fileColumn === true ? true : undefined,
    };
  }

  /**
   * extended is the ref this source is opened by with `files` added at its
   * end, or undefined for a source that is one file.
   *
   * Each part it has now goes with the extent the join measured of it. A part
   * measures the same whatever comes after it, so the longer source places
   * every one of them where it is now without opening it, and holds it to
   * that when a read reaches it: every row keeps its number.
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

/**
 * schemaOf is the empty log of a source just opened, over the columns it
 * shows: the file's, and after them a `_file` column where several files read
 * as one asked for it.
 *
 * The column goes last, so every column the files have keeps the number an
 * edit names it by. It is named as a header's columns are, each once: a file
 * with a `_file` of its own keeps the name, and this one takes a suffix.
 */
function schemaOf(format: Format, parts: PartsRef | undefined): Schema {
  if (parts?.fileColumn !== true) return new Schema(format.columns, 0);
  return new Schema(headerOf([...format.columns, FILE_COLUMN]), 0, {
    col: format.columns.length,
    shows: FILE_SHOWS,
  });
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

/** The link to a file just opened: where it is, and which bytes of it were read. */
function linkTo(path: string, version: string | undefined): Link {
  return version === undefined ? { path } : { path, version };
}

/**
 * turn lets the event loop turn once, so a progress message, or a request that
 * arrived while a long loop ran, goes out before the loop goes on. It answers
 * with the time, which is when the next slice starts.
 */
async function turn(): Promise<number> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return Date.now();
}
