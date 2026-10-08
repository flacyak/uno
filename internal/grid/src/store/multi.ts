// Several files read as one: the bytes of a multi-file source.
//
// A multi-file source is an ordered list of files, called parts, and this is
// the one ByteSource that joins them end to end. The first part is there
// whole. Each later part gives its rows and not its header, which would
// otherwise turn up as a row in the middle of the table, and a part whose last
// row has no newline is given one, so that row never runs into the next
// part's first. Indexing, paging and the edit log read the join as they read
// any file, and none of them knows there are three files behind it.
//
// It is pure: every part is opened through the handlers it is handed, so a
// part is a file on a disk, an object in a bucket or bytes already in hand,
// in any mix, and nothing here knows which.

import { concat } from "../go/index.ts";
import {
  UnsupportedEncodingError,
  bomLength,
  delimiterName,
  encodingName,
  openFormat,
  peekFormat,
} from "../ingest/index.ts";
import type { Encoding, Format, HeaderMode } from "../ingest/index.ts";
import { openWith } from "./index.ts";
import type { ByteSource, FileHandler, SingleRef } from "./index.ts";
// Type only, the way every provider factory beside its transport has it.
import type { Provider } from "../plugin/index.ts";

/**
 * Whether the parts have a header row, which is ingest's to define: it is the
 * same choice a reader of one file is given.
 *
 * With "first", the first part's header names the columns, and every later
 * part opens with the same header, which is skipped. With "none" no part has
 * one, and every line of every part is a row.
 */
export type { HeaderMode };

/**
 * Extent is what the join needs to know about a part to place it, and all it
 * needs: with every part's extent in hand, where each one sits is arithmetic.
 *
 * It is a fact about the part alone, whichever parts are around it, so a part
 * added after it changes nothing in it.
 */
export interface Extent {
  /** How big the part is. */
  bytes: number;
  /**
   * How many bytes at its start the join leaves out: a later part's repeat of
   * the header, or its byte order mark where there is no header or no record
   * in it. 0 for the first part, which is there whole.
   */
  skip: number;
  /** Whether its last byte is something other than a newline. */
  unterminated: boolean;
}

/**
 * Part is one file of a multi-file source.
 *
 * `extent` is what an earlier open measured, handed back. A part that comes
 * with one is not opened until a read needs its bytes, and is held to it
 * then, and to the version on its ref where its place says which bytes it
 * has. A part without one is opened and measured as the source opens.
 */
export interface Part {
  /** Where the part is, and which version of it where a save recorded one.
   * One file, always: a part is never several files itself. */
  ref: SingleRef;
  extent?: Extent;
}

/** Span is where one part sits in the joined bytes. */
export interface Span {
  /** Which part, counting from 0 in the order the source lists them. */
  part: number;
  /** The joined offset of the first byte the part gives. */
  start: number;
  /**
   * One past the last, the virtual newline included. A part that gives
   * nothing has `end` equal to `start`.
   */
  end: number;
  /** How many bytes of the part come before the first one it gives. */
  skip: number;
  /** Whether the byte at `end - 1` is a newline the part itself does not have. */
  newline: boolean;
}

/**
 * PartMap says which part every byte of the join came from.
 *
 * A row belongs to the part its first byte is in, so the offset an index
 * holds for a row is all it takes to name the row's file.
 */
export interface PartMap {
  /** One span per part, in order. */
  readonly spans: readonly Span[];
  /** How long the join is. */
  readonly size: number;
  /**
   * Which part the byte at `offset` came from, counting from 0. A virtual
   * newline belongs to the part it ends. Undefined before the first byte and
   * from `size` on.
   */
  partAt(offset: number): number | undefined;
}

/**
 * MultiSource is the parts read as one file, and what a caller needs to know
 * about them besides.
 *
 * It has no `version` of its own. Each part has one, and `versions` says them.
 */
export interface MultiSource extends ByteSource {
  /** Where each part sits in the join. */
  readonly map: PartMap;
  /** Each part's extent, in order: what a save records so the next open can
   * leave the parts unopened. */
  readonly extents: readonly Extent[];
  /**
   * Which bytes each part is, in order, as its place says: undefined for a
   * part whose place has no versions. It opens every part not yet open.
   */
  versions(): Promise<Array<string | undefined>>;
}

/** ColumnDifference is one column a later part names differently from the first. */
export interface ColumnDifference {
  /** Which column, counting from 0. */
  column: number;
  /** What the first part calls it. */
  first: string;
  /** What this part calls it. */
  part: string;
}

/** NamedColumn is a column one part has and the other does not. */
export interface NamedColumn {
  /** Which column of the part that has it, counting from 0. */
  column: number;
  name: string;
}

/**
 * Disagreement is the way a later part reads differently from the first.
 * `first` is the first part's side of it throughout, and `part` the later
 * part's.
 *
 * A header can differ in several ways at once, and the one named is the one
 * that says the most: a part with the first part's columns in another order
 * is "reordered", and not every column renamed.
 */
export type Disagreement =
  | { kind: "encoding"; first: Encoding; part: Encoding }
  | { kind: "delimiter"; first: string; part: string }
  /** Columns in the same places under other names. */
  | { kind: "renamed"; columns: ColumnDifference[] }
  /** The same names in another order: every column that is out of place. */
  | { kind: "reordered"; columns: ColumnDifference[] }
  /** Columns of the first part this one leaves out, the rest in order. */
  | { kind: "missing"; columns: NamedColumn[] }
  /** Columns of this part the first does not have, the rest in order. */
  | { kind: "extra"; columns: NamedColumn[] }
  /** Headers of different lengths, and the first column that differs. */
  | { kind: "columns"; first: number; part: number; column: ColumnDifference }
  /** With no header row: first rows with different numbers of fields. */
  | { kind: "fields"; first: number; part: number };

/**
 * DisagreementError is the refusal of a source one of whose parts does not
 * read the way the first does. It is thrown as the source opens, or by the
 * read that first reaches the part where the part came with an extent, and by
 * every read of the source after that.
 */
export class DisagreementError extends Error {
  /** Which part, counting from 0. */
  readonly part: number;
  /** The part's name. */
  readonly partName: string;
  /** The name of the first part, which it is held to. */
  readonly firstName: string;
  readonly differs: Disagreement;

  constructor(parts: readonly Part[], part: number, differs: Disagreement) {
    const name = parts[part]!.ref.name;
    const first = parts[0]!.ref.name;
    super(`${partLabel(parts, part)}: ${said(differs, first)}`);
    this.part = part;
    this.partName = name;
    this.firstName = first;
    this.differs = differs;
  }
}

/** How many columns a refusal says by name before it counts the rest. */
const COLUMNS_NAMED = 3;

const LF = 0x0a;

/** How many bytes the virtual newline is. */
const NEWLINE_BYTES = 1;

/** How many bytes a byte order mark can take, which is all a part with no
 * header row is read for at its start. */
const BOM_BYTES = 3;

/** How many parts are opened at once when several are opened together. */
const OPENING = 4;

/**
 * partMap lays the parts end to end.
 *
 * Each gives what is left of it after `skip`. A part that gives something,
 * does not end in a newline and has a part after it is followed by a virtual
 * one. The last part is left as it is, so the join ends the way the file
 * does.
 */
export function partMap(extents: readonly Extent[]): PartMap {
  const spans: Span[] = [];
  let at = 0;
  extents.forEach((extent, part) => {
    const given = Math.max(0, extent.bytes - extent.skip);
    const newline = given > 0 && extent.unterminated && part < extents.length - 1;
    const end = at + given + (newline ? NEWLINE_BYTES : 0);
    spans.push({ part, start: at, end, skip: extent.skip, newline });
    at = end;
  });
  const size = at;

  return {
    spans,
    size,
    partAt(offset) {
      if (!(offset >= 0 && offset < size)) return undefined;
      // The last span that starts at or before the offset. A span that gives
      // nothing starts where the next one does, so it is never the last.
      let low = 0;
      let high = spans.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (spans[mid]!.start <= offset) low = mid;
        else high = mid - 1;
      }
      return low;
    },
  };
}

/**
 * openMulti opens `parts` as one file.
 *
 * A part with no extent is opened here and measured. One that has an extent
 * is left unopened until a read reaches it, so a source saved with its
 * extents opens without touching a single part. With a header, a later part
 * is opened together with the first, whose header it is held to.
 *
 * Every refusal names the part: one that cannot be opened, one that does not
 * read the way the first part does, one that is not what its extent says, and
 * one that changes while it is being read. A part that does not agree with
 * the first is a refusal of the whole source, a `DisagreementError`: found as
 * the source opens, nothing is opened, and found by a read, every read after
 * it is refused the same way.
 */
export async function openMulti(
  handlers: readonly FileHandler[],
  parts: readonly Part[],
  header: HeaderMode,
): Promise<MultiSource> {
  if (parts.length === 0) throw new Error("a multi-file source needs at least one part");
  const opened = new Parts(handlers, parts, header);
  try {
    await opened.measure();
  } catch (err) {
    await opened.close();
    throw err;
  }

  const extents = opened.measured();
  const map = partMap(extents);

  /** The bytes of one span from `from` up to `to`, both joined offsets inside it. */
  async function piece(span: Span, from: number, to: number): Promise<Uint8Array> {
    const body = span.end - (span.newline ? NEWLINE_BYTES : 0);
    // The virtual newline alone is nothing the part has to be opened for.
    if (from >= body) return Uint8Array.of(LF);
    const length = Math.min(to, body) - from;
    const bytes = await opened.read(span.part, span.skip + (from - span.start), length);
    return to > body ? concat([bytes, Uint8Array.of(LF)]) : bytes;
  }

  return {
    size: map.size,
    map,
    extents,
    versions: () => opened.versions(),
    close: () => opened.close(),

    async read(offset, length) {
      const start = Math.max(0, offset);
      const end = Math.min(offset + length, map.size);
      const first = map.partAt(start);
      if (first === undefined || end <= start) return new Uint8Array();

      // One part after another, in order. A read inside one part, which is
      // nearly every read, is handed that part's bytes as they came.
      const pieces: Uint8Array[] = [];
      for (let i = first; i < map.spans.length && map.spans[i]!.start < end; i++) {
        const span = map.spans[i]!;
        if (span.end === span.start) continue;
        pieces.push(await piece(span, Math.max(start, span.start), Math.min(end, span.end)));
      }
      return pieces.length === 1 ? pieces[0]! : concat(pieces);
    },
  };
}

/**
 * Parts opens each part once, when it is first wanted, and holds it to what
 * the source says of it.
 */
class Parts {
  /** Each part's open, once one has been asked for. */
  private readonly sources: Array<Promise<ByteSource> | undefined>;
  /** Each part's extent: the one it came with, or the one its open measured. */
  private readonly extents: Array<Extent | undefined>;
  /**
   * How the first part reads, which every later part is held to: undefined
   * where it has no record in it, which only a source with no header row
   * allows.
   */
  private first: Promise<Format | undefined> | undefined;
  /** The part that was found not to agree, which refuses the whole source. */
  private refused: DisagreementError | undefined;
  /** Whether `close` has been called, after which no part is opened or read. */
  private closed = false;
  private readonly handlers: readonly FileHandler[];
  private readonly parts: readonly Part[];
  private readonly header: HeaderMode;

  constructor(handlers: readonly FileHandler[], parts: readonly Part[], header: HeaderMode) {
    this.handlers = handlers;
    this.parts = parts;
    this.header = header;
    this.sources = parts.map(() => undefined);
    this.extents = parts.map((p) => p.extent);
  }

  /** measure opens every part that came without an extent. */
  async measure(): Promise<void> {
    await this.each((i) => (this.extents[i] === undefined ? this.source(i) : undefined));
  }

  /** Every part's extent, once `measure` has been through them. */
  measured(): Extent[] {
    return this.extents.map((extent, i) => {
      if (extent === undefined) throw new Error(this.named(i, "it has not been measured"));
      return extent;
    });
  }

  /** `length` bytes of part `i` from `offset`, all of which its extent says it has. */
  async read(i: number, offset: number, length: number): Promise<Uint8Array> {
    if (this.refused !== undefined) throw this.refused;
    const source = await this.source(i);
    // Closed while the part was opening, and the part with it.
    if (this.closed) throw new ClosedError();
    let bytes: Uint8Array;
    try {
      bytes = await source.read(offset, length);
    } catch (err) {
      throw this.failed(i, err);
    }
    // A part read short would move every row after it, in every part after it.
    if (bytes.length !== length) {
      throw new PartError(this.named(i, "it changed since it was opened · open the source again"));
    }
    return bytes;
  }

  async versions(): Promise<Array<string | undefined>> {
    const versions: Array<string | undefined> = this.parts.map(() => undefined);
    await this.each(async (i) => {
      versions[i] = (await this.source(i)).version;
    });
    return versions;
  }

  /**
   * close closes every part that was opened, and waits for one still opening
   * to close that too. Nothing is opened after it: a read still on its way,
   * as an index's is when its view is closed, is refused, since a part opened
   * for it would have nobody left to close it.
   */
  async close(): Promise<void> {
    this.closed = true;
    const opening = this.sources.flatMap((s) => (s === undefined ? [] : [s]));
    for (let i = 0; i < this.sources.length; i++) this.sources[i] = undefined;
    const settled = await Promise.allSettled(opening);
    await Promise.all(settled.flatMap((o) => (o.status === "fulfilled" ? [o.value.close()] : [])));
  }

  /**
   * Part `i`, opened the first time it is asked for. An open that fails is
   * forgotten, so the next read asks again rather than repeating the failure.
   * Once the source is closed no part is opened, and the asking is refused.
   */
  private source(i: number): Promise<ByteSource> {
    if (this.closed) return Promise.reject(new ClosedError());
    return (this.sources[i] ??= this.open(i).catch((err: unknown) => {
      this.sources[i] = undefined;
      throw this.failed(i, err);
    }));
  }

  /** open opens part `i`, measures it, and holds it to the extent it came with. */
  private async open(i: number): Promise<ByteSource> {
    const ref = this.parts[i]!.ref;
    const source = await openWith(this.handlers, ref);
    try {
      const was = this.extents[i];
      // An extent came out of a save, and the version beside it says which
      // bytes that save's log was made against. Where the place says these
      // are other bytes, the part is refused before any of it is read: a
      // rewrite the same size would otherwise pass for the file it replaced.
      const saved = was !== undefined && "path" in ref ? ref.version : undefined;
      if (saved !== undefined && source.version !== undefined && source.version !== saved) {
        throw new Error("it is not the version this source was saved against");
      }
      const extent: Extent = {
        bytes: source.size,
        skip: await this.skip(i, source),
        unterminated: source.size > 0 && (await source.read(source.size - 1, 1))[0] !== LF,
      };
      if (was !== undefined && !same(was, extent)) {
        const sizes =
          was.bytes === extent.bytes ? "" : ` · it is ${extent.bytes} bytes and was ${was.bytes}`;
        throw new Error(`it is not the file this source was made from${sizes}`);
      }
      this.extents[i] = extent;
      return source;
    } catch (err) {
      await source.close();
      throw err;
    }
  }

  /**
   * skip is how much of part `i` the join leaves out at its start.
   *
   * The first part is there whole. A later part has to read the way the first
   * does, and with a header it is left out up to its first row. A part with
   * no record in it, whether it is no bytes, blank lines or a byte order mark
   * alone, has nothing to check and gives no rows, header or none. With no
   * header, only a byte order mark is left out, which in the middle of the
   * join would be read as a character of the first cell, and a part of blank
   * lines alone has no row to hold to the first part's.
   */
  private async skip(i: number, source: ByteSource): Promise<number> {
    if (i === 0 || source.size === 0) return 0;

    const format = await this.formatOrDiffers(i, source);
    const first = format === undefined ? undefined : await this.firstFormat();
    if (format !== undefined && first !== undefined) {
      const differs = disagreement(first, format, this.header);
      if (differs !== undefined) {
        this.refuse(i, differs);
      }
    }
    // A part read as having no header row starts its rows after a byte order
    // mark and nothing else, so where its rows start is what is left out
    // either way. A part with no record in it has only the mark to leave out:
    // its blank lines are blank lines of the join, which no row begins in.
    if (format === undefined) return bomLength(await source.read(0, BOM_BYTES));
    return format.dataStart;
  }

  /**
   * formatOrDiffers is `format`, with a part in an encoding this build cannot
   * read refused as the disagreement it is: it does not read the way the
   * first part does, and both encodings are named, rather than the part's
   * alone as if it were a file on its own.
   */
  private async formatOrDiffers(i: number, source: ByteSource): Promise<Format | undefined> {
    try {
      return await this.format(i, source);
    } catch (err) {
      if (!(err instanceof UnsupportedEncodingError)) throw err;
      const first = await this.firstFormat();
      if (first === undefined) throw err;
      this.refuse(i, { kind: "encoding", first: first.encoding, part: err.encoding });
    }
  }

  /**
   * refuse is part `i` not reading the way the first does. Parts are opened
   * several at a time and land in any order. The one the source is refused
   * for is the first in the list that disagrees, so the same parts give the
   * same refusal on every open.
   */
  private refuse(i: number, differs: Disagreement): never {
    const refusal = new DisagreementError(this.parts, i, differs);
    if (this.refused === undefined || i < this.refused.part) this.refused = refusal;
    throw refusal;
  }

  /**
   * How part `i` reads: undefined where it has no record in it. The first
   * part is refused for that where there is a header row, since it is the
   * header every other part is held to. A later part with no record in it
   * has no header to hold to the first's and no rows to give, which is the
   * same nothing whatever its bytes are.
   */
  private format(i: number, source: ByteSource): Promise<Format | undefined> {
    const name = this.parts[i]!.ref.name;
    return this.header === "first" && i === 0
      ? openFormat(name, source)
      : peekFormat(name, source, this.header);
  }

  /** How the first part reads, read once. */
  private firstFormat(): Promise<Format | undefined> {
    return (this.first ??= this.source(0)
      .then((source) => this.format(0, source))
      .catch((err: unknown) => {
        this.first = undefined;
        throw this.failed(0, err);
      }));
  }

  /**
   * each runs `run` for every part, `OPENING` at a time, and waits for all
   * that started. It stops starting them at the first failure.
   *
   * What it throws is the failure of the earliest part in the list that
   * failed, whichever landed first. Parts are started in order, so every
   * part before a failed one was started and waited for, and the earliest
   * failure is the same one on every run.
   */
  private async each(run: (i: number) => Promise<unknown> | undefined): Promise<void> {
    let next = 0;
    const failures: Array<{ part: number; reason: unknown }> = [];
    const worker = async (): Promise<void> => {
      while (next < this.parts.length && failures.length === 0) {
        const part = next++;
        try {
          await run(part);
        } catch (reason) {
          failures.push({ part, reason });
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(OPENING, this.parts.length) }, worker));

    const [first] = failures.toSorted((a, b) => a.part - b.part);
    if (first !== undefined) throw first.reason;
  }

  /** A sentence about part `i` that says which part it is. */
  private named(i: number, what: string): string {
    return `${partLabel(this.parts, i)}: ${what}`;
  }

  /** failed is `err` with the part it happened to named, once. */
  private failed(i: number, err: unknown): Error {
    if (err instanceof PartError || err instanceof DisagreementError) return err;
    // The whole source was closed, which is no one part's failure.
    if (err instanceof ClosedError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new PartError(this.named(i, message), { cause: err });
  }
}

/** An error that already names its part, so it is not named again on the way out. */
class PartError extends Error {}

/** The refusal of a read that reaches a source after it was closed. */
class ClosedError extends Error {
  constructor() {
    super("the source was closed");
  }
}

/**
 * disagreement says how a later part reads differently from the first, or
 * undefined where the two agree. Every way parts have to agree belongs here.
 *
 * The encoding comes first and the delimiter second, since a header read
 * with the wrong one of either is not a header to compare. A byte order mark
 * is no part of it: UTF-8 with one and without is the same encoding. With no
 * header row there are no names to hold a part to, and its first row has to
 * have as many fields as the first part's.
 */
function disagreement(first: Format, part: Format, header: HeaderMode): Disagreement | undefined {
  if (first.encoding !== part.encoding) {
    return { kind: "encoding", first: first.encoding, part: part.encoding };
  }
  if (first.delimiter !== part.delimiter) {
    return { kind: "delimiter", first: first.delimiter, part: part.delimiter };
  }
  if (header === "none") {
    return first.columns.length === part.columns.length
      ? undefined
      : { kind: "fields", first: first.columns.length, part: part.columns.length };
  }
  return headerDisagreement(first.columns, part.columns);
}

/** headerDisagreement is how a later part's header differs from the first's. */
function headerDisagreement(
  first: readonly string[],
  part: readonly string[],
): Disagreement | undefined {
  const shared = Math.min(first.length, part.length);
  const differing: ColumnDifference[] = [];
  for (let column = 0; column < shared; column++) {
    if (first[column] !== part[column]) {
      differing.push({ column, first: first[column]!, part: part[column]! });
    }
  }

  if (first.length === part.length) {
    if (differing.length === 0) return undefined;
    // Each header sorted once: sorting the part's again per column is a wait
    // of seconds for a header thousands of columns wide.
    const sorted = part.toSorted();
    const reordered = first.toSorted().every((name, at) => name === sorted[at]);
    return { kind: reordered ? "reordered" : "renamed", columns: differing };
  }

  if (part.length < first.length) {
    const missing = without(first, part);
    if (missing !== undefined) return { kind: "missing", columns: missing };
  } else {
    const extra = without(part, first);
    if (extra !== undefined) return { kind: "extra", columns: extra };
  }
  // Neither header is the other with columns taken out, so one of the
  // columns they both have differs.
  return { kind: "columns", first: first.length, part: part.length, column: differing[0]! };
}

/**
 * without is the columns of `longer` that `shorter` leaves out, where
 * `shorter` is `longer` with columns taken out and the rest in order, and
 * undefined where it is anything else.
 */
function without(longer: readonly string[], shorter: readonly string[]): NamedColumn[] | undefined {
  const left: NamedColumn[] = [];
  let kept = 0;
  longer.forEach((name, column) => {
    if (kept < shorter.length && shorter[kept] === name) kept++;
    else left.push({ column, name });
  });
  return kept === shorter.length ? left : undefined;
}

/** said is a disagreement as the rest of a sentence that opens with the part's name. */
function said(differs: Disagreement, first: string): string {
  switch (differs.kind) {
    case "encoding":
      return `its text encoding is ${encodingName(differs.part)} and ${first}'s is ${encodingName(differs.first)}`;
    case "delimiter":
      return `it is ${delimiterName(differs.part)}-separated and ${first} is ${delimiterName(differs.first)}-separated`;
    case "renamed":
      return listed(differs.columns, (c) => renamed(c, first));
    case "reordered":
      return `its columns are in another order than ${first}'s · ${listed(differs.columns, (c) => renamed(c, first))}`;
    case "missing":
      return listed(
        differs.columns,
        (c) => `it has no ${quoted(c.name)}, which is column ${c.column + 1} of ${first}`,
      );
    case "extra":
      return listed(
        differs.columns,
        (c) => `its column ${c.column + 1} is ${quoted(c.name)}, which ${first} does not have`,
      );
    case "columns":
      return `it has ${counted(differs.part)} and ${first} has ${differs.first} · ${renamed(differs.column, first)}`;
    case "fields":
      return `its first row has ${counted(differs.part)} and ${first}'s has ${differs.first}`;
  }
}

function renamed(c: ColumnDifference, first: string): string {
  return `column ${c.column + 1} is ${quoted(c.part)} where ${first} has ${quoted(c.first)}`;
}

/** The first few of `columns`, each as `say` says it, and a count of the rest. */
function listed<T>(columns: readonly T[], say: (column: T) => string): string {
  const named = columns.slice(0, COLUMNS_NAMED).map(say);
  const rest = columns.length - named.length;
  if (rest > 0) named.push(`and ${counted(rest, "more ")}`);
  return named.join(" · ");
}

function counted(n: number, more = ""): string {
  return `${n} ${more}${n === 1 ? "column" : "columns"}`;
}

/** partLabel names part `i` as a person is told of it: its file, and its place in the list. */
function partLabel(parts: readonly Part[], i: number): string {
  return `${parts[i]!.ref.name} (part ${i + 1} of ${parts.length})`;
}

/** A name in quotes, so a space at its end or a tab inside it can be seen. */
function quoted(name: string): string {
  return JSON.stringify(name);
}

function same(a: Extent, b: Extent): boolean {
  return a.bytes === b.bytes && a.skip === b.skip && a.unterminated === b.unterminated;
}

// ------------------------------------------------------------ the handler

/** What a person would call a source of several files, for an error that names it. */
const LABEL = "several files as one";

/** Every source `multiFiles` opened, so one can be told from any other ByteSource. */
const joined = new WeakMap<ByteSource, MultiSource>();

/**
 * multiFiles opens a ref of several parts as one file. It claims every ref
 * that has parts, and opens each part through `handlers`, so a part is
 * whatever those open: a platform lists it after the handlers it is given.
 *
 * It is a handler like the others so that reading several files as one is a
 * platform's decision. An engine that does not list it refuses such a ref by
 * name rather than opening its first part.
 *
 * What it opens is a MultiSource, and `multiOf` hands that back to a caller
 * that got it through `openWith` as a ByteSource.
 */
export function multiFiles(handlers: readonly FileHandler[]): FileHandler {
  return {
    label: LABEL,
    handles: (ref) => "parts" in ref,

    async open(ref) {
      if (!("parts" in ref)) throw new Error(`${ref.name}: not several files read as one`);
      const { name, parts, header } = ref;
      if (parts.length === 0) {
        throw new Error(`${name} has no parts · several files read as one needs at least one`);
      }
      // A ref is plain data that crossed a channel or came out of a file, so
      // what its type rules out is still looked for.
      const nested = parts.findIndex((part) => "parts" in part.ref);
      if (nested >= 0) {
        throw new Error(
          `${name}: ${partLabel(parts, nested)} is several files itself · a part is one file`,
        );
      }
      const source = await openMulti(handlers, parts, header);
      joined.set(source, source);
      return source;
    },
  };
}

/**
 * multiOf is the MultiSource behind a source `multiFiles` opened -- its map,
 * its extents, each part's version -- and undefined for any other source.
 */
export function multiOf(source: ByteSource): MultiSource | undefined {
  return joined.get(source);
}

/**
 * multiProvider is several files read as one, plugged in over the providers a
 * platform lists: a handler and nothing to browse, since its parts are browsed
 * where they are.
 */
export function multiProvider(providers: readonly Provider[]): Provider {
  return { name: "multi", label: LABEL, files: multiFiles(providers.map((p) => p.files)) };
}
