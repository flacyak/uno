/**
 * @fileoverview One source in a workspace: the reading of its rows, its edit
 * log, and the rows read through both.
 *
 * Every row returned has the log applied. An edit is one line folded into
 * the Schema and a new generation number. Every stored row stays as read.
 */

import type { HeldFile, HeldPart, HeldParts } from '@document';
import { trimSpace } from '@go';
import { headerOf } from '@ingest';
import type { Column } from '@ingest';
import { isNumber } from '@num';
import { MIN_EXAMPLES, Survey, gather } from '@pattern';
import type { Example } from '@pattern';
import { described as describedProgram, text as programText } from '@program';
import {
  NO_ROW,
  Op,
  SAMPLE_ROWS,
  Schema,
  finishRows,
  inferKind,
  isDate,
  valueAt,
} from '@sheet';
import type { Edit, Written } from '@sheet';
import type { ByteSource, HeaderMode, PartsRef, SingleRef } from '@store';
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
  RowsPage,
} from './protocol.ts';
import { FILE_SHOWS, Refusal, saidOf } from '@said';
import type { Said } from '@said';
import { openReading } from './reading.ts';
import type { Expected, Reading, ReadSpec } from './reading.ts';
import type { Tuning } from './rows.ts';
import {
  BYTES,
  INDEX,
  INDEXED,
  MILLISECONDS,
  unmeasured,
} from './telemetry.ts';
import type { Telemetry } from './telemetry.ts';

/** Minimum milliseconds between progress messages. */
const PROGRESS_MS = 100;

/** Milliseconds a long loop runs before yielding to the event loop. */
const SLICE_MS = 8;

/**
 * The header of the column that names each row's file, in a source over
 * several files that asked for one.
 */
export const FILE_COLUMN = '_file';

type Waiter = () => boolean;

/** Sample is the rows each column's kind is inferred from, and the values supplied for them. */
interface Sample {
  rows: string[][];
  supplied: (readonly string[])[] | undefined;
}

/** What a column blank in every sample row is inferred as. */
const BLANK = inferKind(0, () => '');

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
export type Part = (Omit<HeldFile, Unsaved> | Omit<HeldParts, Unsaved>) & {
  edits: Edit[];
};
type Unsaved = 'id' | 'name' | 'state';

/**
 * Origin is what a source's bytes were handed as, which its index
 * measurements name: bytes a .uno carried, a dropped file, several files
 * read as one, an object in a bucket, or a file on a disk.
 */
export type Origin = 'carried' | 'dropped' | 'joined' | 'bucket' | 'disk';

/**
 * Stored is how a source's stored bytes are handed to a View: a ByteSource
 * over one file, or over several files joined as bytes.
 */
export type Stored = { readonly t: 'source'; readonly source: ByteSource };

/** What View.open is given. */
export interface OpenAsk {
  id: string;
  /** The file's name. `ingest` picks a decoder by it. */
  name: string;
  /** Where the bytes are, or "" where no one path holds them. */
  path: string;
  /** The stored bytes. The view owns them from here on and closes them if
   * the open fails. */
  stored: Stored;
  /** What the bytes were handed as. */
  origin: Origin;
  port: Port<Request, Reply>;
  tuning: Tuning;
  /**
   * When the caller started opening the source, before it opened the file
   * where it did. The time a Progress reports counts from it.
   */
  began: number;
  /** The edits, and for a carried source the bytes, a .uno holds for it. */
  carried?: Carried;
  /** How a .uno says the rows were read when its log was made. Detection is
   * skipped, and the bytes are read so. */
  read?: ReadSpec;
  /** What a relink holds one file to. One detected as another kind of rows
   * than its log was read as is refused. */
  expect?: Expected;
  telemetry?: Telemetry;
  /** Whether the first line names the columns. A header row unless said. */
  header?: HeaderMode;
  /** Set for a source over several files. */
  parts?: PartsRef;
  /** Aborted to cancel the open while it still waits for its sample rows. */
  signal?: AbortSignal;
}

export class View {
  /** The source's id in the workspace and its log. */
  readonly id: string;
  /** The file's name. `ingest` picks a decoder by it. */
  readonly name: string;
  private readonly port: Port<Request, Reply>;
  /**
   * When the open began. A Progress's time and the INDEX measurement both
   * count from here, so the status bar and the collector agree.
   */
  private readonly began: number;

  opened!: Opened;
  generation = 0;

  /** How the source's rows are found and read, and what holds its bytes. */
  private reading!: Reading;
  private schema!: Schema;
  /**
   * The columns as last worked out, which a widen extends. Set first in the
   * turn the open's answer is built.
   */
  private lastColumns: ColumnInfo[] | undefined;

  /** The source bytes a .uno carried. Undefined for a file read from disk. */
  private carried: Uint8Array | undefined;

  /** The file's path. Empty for carried bytes, and for a source over several
   * files. */
  readonly path: string;

  /** The id of the connection the file was read through, if any. */
  connection: string | undefined;

  /** The parts ref a source over several files was opened from. */
  parts: PartsRef | undefined;

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
  /** The close under way or done. A later close returns it. */
  private closing: Promise<void> | undefined;

  /** How long the open had taken when the index completed, final from then on. */
  private took: number | undefined;

  private constructor(
    id: string,
    name: string,
    path: string,
    port: Port<Request, Reply>,
    began: number,
  ) {
    this.id = id;
    this.name = name;
    this.port = port;
    this.began = began;
    this.path = path;
  }

  /**
   * open opens the reading, starts indexing, waits for the sample rows,
   * replays any carried edits, and returns the view.
   */
  static async open(ask: OpenAsk): Promise<View> {
    const { id, name, path, port, tuning, carried, began } = ask;
    const { source } = ask.stored;
    const telemetry = ask.telemetry ?? unmeasured;
    const v = new View(id, name, path, port, began);
    v.carried = carried?.raw;
    v.parts = ask.parts;

    // Errors for a source from a .uno name the .uno as well.
    const container = carried === undefined ? '' : carried.container;
    const within = (why: Said): Said =>
      container === '' ? why : { t: 'about', subject: container, why };

    const header = ask.header ?? 'first';
    try {
      // A source from a .uno, relinked or appended to is read as its log
      // was made. Several files opened anew are read as delimited text, each
      // part detected as it is measured. A file on its own is detected, and
      // its head read once.
      v.reading = await openReading({
        name,
        source,
        spec:
          ask.read ??
          (ask.parts === undefined ? undefined : { kind: 'delimited', header }),
        expect: ask.expect,
        header,
        tuning,
      });
    } catch (err) {
      await source.close();
      if (container === '') throw err;
      throw new Refusal(
        within({ t: 'about', subject: name, why: saidOf(err) }),
      );
    }

    const reading = v.reading;
    v.schema = schemaOf(reading.columns(), ask.parts);

    // A cancel fails the wait below with its refusal, kept ahead of the
    // close's own, and closes the view, which stops the index.
    const signal = ask.signal;
    const cancelled = (): void => {
      v.fail(new Refusal({ t: 'cancelled', name }));
      // A close that fails is reported by the open's own catch, which closes
      // again and awaits it, so the listener's call must not surface it as
      // an unhandled rejection.
      v.close().catch(() => undefined);
    };
    // The file open and the format sniff take no signal, so an abort during
    // them takes effect here, once they return.
    if (signal?.aborted) cancelled();
    else signal?.addEventListener('abort', cancelled, { once: true });

    let told = 0;
    let started = false;
    const index = reading.index;
    reading
      .pass(v.abort.signal, () => {
        v.widen();
        v.wake();
        if (index.complete) {
          // The clock stops here, once: the pass reports completion one time.
          v.took = performance.now() - v.began;
          const attributes = { place: ask.origin };
          telemetry({
            name: INDEX,
            kind: 'duration',
            unit: MILLISECONDS,
            value: v.took,
            attributes,
          });
          telemetry({
            name: INDEXED,
            kind: 'count',
            unit: BYTES,
            value: index.indexed().total,
            attributes,
          });
        }
        const now = Date.now();
        if (!index.complete && now - told < PROGRESS_MS) return;
        told = now;
        port.post({ t: 'progress', source: id, progress: v.progress() });
      })
      .catch((err: unknown) => {
        v.fail(err);
        // Before open returns, the failure is thrown from open instead. After
        // a close, the abort is the cause and the failure is swallowed.
        if (started && !v.abort.signal.aborted) {
          port.post({
            t: 'error',
            source: id,
            said: { t: 'about', subject: name, why: saidOf(err) },
          });
        }
      });

    try {
      // Wait until the index covers the sample rows and the deepest row the
      // carried edits name. Carried bytes wait for the whole index.
      const want = Math.max(SAMPLE_ROWS, deepest(carried?.edits));
      const whole = carried?.raw !== undefined;
      await v.until(
        () => index.complete || (!whole && index.readable() >= want),
      );
      // From here the open is answered, so a cancel is left unheard.
      signal?.removeEventListener('abort', cancelled);
      started = true;

      if (carried !== undefined) {
        v.schema.rows = index.readable();
        try {
          v.schema.replay(carried.edits);
        } catch (err) {
          throw new Refusal(within({ t: 'replaying', name, why: saidOf(err) }));
        }
      }

      // The columns are worked out in the turn the answer is built, so a
      // widen after it extends what the answer says.
      const sample = await v.sample();
      v.opened = {
        source: id,
        name,
        size: v.bytes.size,
        label: reading.label,
        columns: v.columnsOf(sample),
        progress: v.progress(),
        edits: carried?.edits ?? [],
        generation: v.generation,
        link: path === '' ? undefined : linkTo(path, v.bytes.version),
      };
      return v;
    } catch (err) {
      signal?.removeEventListener('abort', cancelled);
      await v.close();
      throw err;
    }
  }

  /** progress is how far the index has got, and how long the open has taken. */
  private progress(): Progress {
    const index = this.reading.index;
    const { done, total } = index.indexed();
    return {
      done,
      total,
      readable: index.readable(),
      rows: index.rows(),
      complete: index.complete,
      elapsedMs: this.took ?? performance.now() - this.began,
    };
  }

  // ------------------------------------------------------------ reading

  /** rows reads rows with the log applied, tagged with the generation they were built at. */
  async rows(first: number, count: number): Promise<RowsPage> {
    const source = await this.reading.pages.rows(first, count);
    const supplied = await this.suppliedFor(Math.max(0, first), source.length);
    const schema = this.schema;
    const generation = this.generation;

    if (schema.empty && supplied === undefined)
      return { generation, rows: source, raws: [] };

    const rows: string[][] = [];
    const raws: Array<string[] | null> = [];
    for (const f of finishRows(schema, first, source, supplied)) {
      rows.push(f.shown as string[]);
      raws.push(f.shown === f.raw ? null : (f.raw as string[]));
    }
    return { generation, rows, raws };
  }

  /** columns infers each column's kind from the sample rows, with the log applied. */
  private async columns(): Promise<ColumnInfo[]> {
    return this.columnsOf(await this.sample());
  }

  /** sample reads the rows each column's kind is inferred from. */
  private async sample(): Promise<Sample> {
    const rows = await this.reading.pages.rows(0, SAMPLE_ROWS);
    return { rows, supplied: await this.suppliedFor(0, rows.length) };
  }

  /**
   * columnsOf infers each column's kind from `sample`, with the log applied
   * as it stands, and keeps them as the last columns.
   */
  private columnsOf({ rows, supplied }: Sample): ColumnInfo[] {
    const schema = this.schema;
    const shown = finishRows(schema, 0, rows, supplied).map((f) => f.shown);
    this.lastColumns = schema.headers.map((header, col) => {
      const { kind, flagged } = inferKind(
        shown.length,
        (row) => shown[row]![col] ?? '',
      );
      const binding = schema.binding(col);
      return binding === undefined
        ? { header, kind, flagged }
        : { header, kind, flagged, binding };
    });
    return this.lastColumns;
  }

  /**
   * widen gives the schema a data column, before the supplied ones, for
   * each column the reading has found since the schema last grew. The pass
   * calls it in the turn it finds them, so no block decoded over a new
   * column meets a schema without it. Rows built before are stale, so the
   * generation moves on.
   *
   * Once the open's answer is built, it is kept saying every column, and
   * every client is told by a widened reply. The open waits for the sample
   * rows to be indexed, so a column found after it is blank in each.
   */
  private widen(): void {
    const schema = this.schema;
    const had = schema.headers.length - schema.supplied.length;
    const found = this.reading.columns();
    if (found.length <= had) return;
    schema.widen(found.slice(had).map((column) => column.name));
    this.generation++;

    const last = this.lastColumns;
    if (last === undefined) return;
    const added = schema.headers
      .slice(had, found.length)
      .map((header): ColumnInfo => ({ header, ...BLANK }));
    const columns = [...last.slice(0, had), ...added, ...last.slice(had)];
    this.lastColumns = columns;
    this.opened.columns = columns;
    this.opened.generation = this.generation;
    this.port.post({
      t: 'widened',
      source: this.id,
      generation: this.generation,
      columns,
    });
  }

  /**
   * suppliedFor returns, for each of `count` rows from `first`, the values
   * of the schema's supplied columns that the part holding the row's first
   * byte supplies. Each part's values are built once, and its rows share
   * them. Undefined for a source with no supplied columns.
   */
  private async suppliedFor(
    first: number,
    count: number,
  ): Promise<(readonly string[])[] | undefined> {
    if (this.schema.supplied.length === 0) return undefined;
    const ref = this.parts;
    const reading = this.reading;
    if (ref === undefined || reading.behind.t !== 'bytes') {
      throw new Refusal({ t: 'joins-unknown-for-column', name: this.name });
    }

    const byPart = new Map<number, readonly string[]>();
    const values: (readonly string[])[] = [];
    const end = first + count;
    for (let row = first; row < end;) {
      const block = reading.index.blockOf(row);
      const [from, to] = reading.index.rowsOf(block);
      const runs = await reading.runs(block);
      for (let run = 0; row < Math.min(to, end); row++) {
        while (run + 1 < runs.length && runs[run + 1]!.row <= row - from) run++;
        const part = runs[run]!.part;
        let supplies = byPart.get(part);
        if (supplies === undefined) {
          supplies = suppliedBy(ref, part);
          byPart.set(part, supplies);
        }
        values.push(supplies);
      }
    }
    return values;
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
      if (last === undefined) throw new Refusal({ t: 'nothing-to-undo' });
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
      if (e === undefined) throw new Refusal({ t: 'nothing-to-redo' });

      this.schema.rows = this.reading.index.readable();
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

    const index = this.reading.index;
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
      const [row] = await this.reading.pages.rows(req.row, 1);
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
    return {
      edit: e,
      generation: this.generation,
      columns: await this.columns(),
    };
  }

  /** refuseInView throws while the view is in view mode. */
  private refuseInView(): void {
    if (!this.transform) throw new Refusal({ t: 'in-view' });
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

    const byCol = this.transform
      ? gather(this.schema.edits())
      : new Map<number, Example[]>();
    const cols = [...byCol]
      .filter(([, examples]) => examples.length >= MIN_EXAMPLES)
      .map(([col]) => col)
      .sort((a, b) => a - b);

    if (cols.length === 0) {
      this.port.post({
        t: 'offer',
        source: this.id,
        generation: this.generation,
        offer: null,
      });
      return;
    }

    const abort = new AbortController();
    this.survey = abort;
    this.surveyColumns(cols, byCol, abort.signal).catch((err: unknown) => {
      if (!abort.signal.aborted) {
        this.port.post({ t: 'error', source: this.id, said: saidOf(err) });
      }
    });
  }

  /**
   * surveyColumns reads each column with enough examples, a block at a
   * time, and posts the first proposal one of them supports. Partial offers
   * are posted every PROGRESS_MS. It waits for the index to reach each row
   * before reading it.
   *
   * A new edit aborts the survey, so one still running was started over the
   * log as it stands. An offer is posted at the generation of when it is
   * posted: a widen moves no data column, so an offer holds across it.
   */
  private async surveyColumns(
    cols: number[],
    byCol: Map<number, Example[]>,
    signal: AbortSignal,
  ): Promise<void> {
    const schema = this.schema;
    const index = this.reading.index;

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
        const records = await this.reading.pages.records(block, false);
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
          this.offer(survey, false);
        }
        if (now - slice >= SLICE_MS) slice = await turn();
      }

      if (signal.aborted) return;
      if (survey.proposal() !== undefined) {
        this.offer(survey, true);
        return;
      }
    }
    if (!signal.aborted) {
      this.port.post({
        t: 'offer',
        source: this.id,
        generation: this.generation,
        offer: null,
      });
    }
  }

  private offer(survey: Survey, complete: boolean): void {
    const p = survey.proposal();
    if (p === undefined) return;
    this.port.post({
      t: 'offer',
      source: this.id,
      generation: this.generation,
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
        rows: this.reading.index.rows(),
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
    if (matches === undefined)
      return { row: null, searched: 0, complete: true };

    const index = this.reading.index;
    const down = req.dir === 1;
    let row = down
      ? Math.max(0, req.from + 1)
      : Math.min(index.readable(), req.from) - 1;
    let searched = 0;
    let slice = Date.now();

    while (down ? row < index.readable() : row >= 0) {
      const block = index.blockOf(row);
      const [from, end] = index.rowsOf(block);
      const records = await this.reading.pages.records(block, false);
      const supplied = await this.suppliedFor(from, records.length);
      if (abort.signal.aborted) return { row: null, searched, complete: false };

      // Only the searched column is finished.
      const shown = this.shownIn(req.col, from, records, supplied);
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
   * the value supplied for a supplied column, or the stored value.
   */
  private shownIn(
    col: number,
    from: number,
    records: readonly (readonly string[])[],
    supplied: readonly (readonly string[])[] | undefined,
  ): (row: number) => string {
    const schema = this.schema;
    if (schema.formula(col) !== undefined) {
      const finished = finishRows(schema, from, records, supplied);
      return (row) => finished[row - from]!.shown[col] ?? '';
    }
    const nth = schema.supplied.findIndex((s) => s.col === col);
    if (nth >= 0) {
      return (row) =>
        schema.writtenIn(row)?.get(col)?.rendered ??
        supplied?.[row - from]?.[nth] ??
        '';
    }
    return (row) =>
      schema.writtenIn(row)?.get(col)?.rendered ??
      valueAt(schema, row, col, records[row - from]!);
  }

  /**
   * matcher returns the test a find applies to each cell's shown value, or
   * undefined for a request with zero possible matches.
   *
   * An "unparsed" match tests a date column with isDate and a numeric or
   * flagged column with isNumber. A blank cell is skipped.
   */
  private async matcher(
    req: FindRequest,
  ): Promise<((shown: string) => boolean) | undefined> {
    if (req.match.t === 'text') {
      const text = req.match.text;
      return text === '' ? undefined : (shown) => shown.includes(text);
    }

    const column = (await this.columns())[req.col];
    if (column === undefined) return undefined;
    const parses =
      column.kind === 'date'
        ? isDate
        : column.kind === 'num' || column.flagged
          ? isNumber
          : undefined;
    if (parses === undefined) return undefined;
    return (shown) => {
      const v = trimSpace(shown);
      return v !== '' && !parses(v);
    };
  }

  // ------------------------------------------------------------ saving

  /** The stored bytes behind the reading: one file, or several as one. */
  private get bytes(): ByteSource {
    const { behind } = this.reading;
    return behind.t === 'file' ? behind.stored : behind.joined;
  }

  /** How the source's rows are read, as a save records it. */
  get spec(): ReadSpec {
    return this.reading.spec();
  }

  /** The size of the carried bytes, or of the source. */
  get size(): number {
    return this.carried?.length ?? this.bytes.size;
  }

  /** The version the source was read at, where the store reports one.
   * Undefined for a carried source and a source over several files. */
  get version(): string | undefined {
    return this.path === '' ? undefined : this.bytes.version;
  }

  /** Bytes a save would copy into the container: the size for a carried
   * source, otherwise 0. */
  get carries(): number {
    return this.path === '' && this.parts === undefined ? this.size : 0;
  }

  /** The current edit log. */
  get log(): Edit[] {
    return this.schema.edits();
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
        return {
          ...(await this.joined(this.parts)),
          connection: this.connection,
          ...this.kept(),
        };
      }
      if (this.path === '') {
        await this.until(() => this.reading.index.complete);
        const raw = this.carried ?? (await this.bytes.read(0, this.bytes.size));
        return { raw, bytes: this.size, version: this.version, ...this.kept() };
      }
      return {
        path: this.path,
        bytes: this.size,
        version: this.version,
        connection: this.connection,
        ...this.kept(),
      };
    });
  }

  /** kept returns the edits and the row and column counts they were made over. */
  private kept(): Pick<Part, 'edits' | 'rows' | 'cols'> {
    return {
      edits: this.schema.edits(),
      rows: this.reading.index.readable(),
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
    const { behind } = this.reading;
    if (behind.t !== 'bytes') {
      throw new Refusal({
        t: 'joins-unknown-for-save',
        name: this.name,
        count,
      });
    }

    const files = ref.parts.map(({ ref: file }, i) => {
      if (!('path' in file)) {
        throw new Refusal({
          t: 'part-has-no-path',
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
    const multi = behind.joined;
    const versions = await multi
      .versions()
      .catch(() => files.map((file) => file.version));

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
    const { behind } = this.reading;
    const extents = behind.t === 'bytes' ? behind.joined.extents : undefined;
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

  /** close stops the passes and closes the source. A second close returns
   * the first. */
  close(): Promise<void> {
    this.closing ??= this.shut();
    return this.closing;
  }

  private async shut(): Promise<void> {
    this.abort.abort();
    this.survey?.abort();
    this.finding?.abort();
    this.fail(new Refusal({ t: 'file-closed' }));
    await this.reading.close();
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
function schemaOf(
  columns: readonly Column[],
  parts: PartsRef | undefined,
): Schema {
  const names = columns.map((column) => column.name);
  if (parts?.fileColumn !== true) return new Schema(names, 0);
  return new Schema(headerOf([...names, FILE_COLUMN]), 0, [
    { col: names.length, shows: FILE_SHOWS },
  ]);
}

/**
 * suppliedBy returns the values one part of a source supplies, in the order
 * schemaOf adds their columns: today its name alone, for `_file`.
 */
function suppliedBy(ref: PartsRef, part: number): readonly string[] {
  return [ref.parts[part]?.ref.name ?? ''];
}

/** deepest returns one past the highest row the edits name, or 0 when none
 * names a row. */
function deepest(edits: readonly Edit[] | undefined): number {
  let row = NO_ROW;
  for (const e of edits ?? []) if (e.row > row) row = e.row;
  return row + 1;
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
