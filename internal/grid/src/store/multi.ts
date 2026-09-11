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

import { bomLength, delimiterName, encodingName, openFormat, peekFormat } from "../ingest/index.ts";
import type { Encoding, Format } from "../ingest/index.ts";
import { openWith } from "./index.ts";
import type { ByteSource, FileHandler, FileRef } from "./index.ts";

/**
 * Whether the parts have a header row.
 *
 * With "first", the first part's header names the columns, and every later
 * part opens with the same header, which is skipped. With "none" no part has
 * one, and every line of every part is a row.
 */
export type HeaderMode = "first" | "none";

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
   * the header, or its byte order mark where there is no header. 0 for the
   * first part, which is there whole.
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
 * then. A part without one is opened and measured as the source opens.
 */
export interface Part {
  /** Where the part is, and which version of it where a save recorded one. */
  ref: FileRef;
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
    super(`${name} (part ${part + 1} of ${parts.length}): ${said(differs, first)}`);
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

  /** close closes every part that was opened, and waits for one still opening
   * to close that too. */
  async close(): Promise<void> {
    const opening = this.sources.flatMap((s) => (s === undefined ? [] : [s]));
    for (let i = 0; i < this.sources.length; i++) this.sources[i] = undefined;
    const settled = await Promise.allSettled(opening);
    await Promise.all(settled.flatMap((o) => (o.status === "fulfilled" ? [o.value.close()] : [])));
  }

  /**
   * Part `i`, opened the first time it is asked for. An open that fails is
   * forgotten, so the next read asks again rather than repeating the failure.
   */
  private source(i: number): Promise<ByteSource> {
    return (this.sources[i] ??= this.open(i).catch((err: unknown) => {
      this.sources[i] = undefined;
      throw this.failed(i, err);
    }));
  }

  /** open opens part `i`, measures it, and holds it to the extent it came with. */
  private async open(i: number): Promise<ByteSource> {
    const source = await openWith(this.handlers, this.parts[i]!.ref);
    try {
      const was = this.extents[i];
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
   * nothing in it has nothing to check and gives no rows. With no header,
   * only a byte order mark is left out, which in the middle of the join would
   * be read as a character of the first cell, and a part of blank lines alone
   * has no row to hold to the first part's.
   */
  private async skip(i: number, source: ByteSource): Promise<number> {
    if (i === 0 || source.size === 0) return 0;

    const format = await this.format(i, source);
    const first = format === undefined ? undefined : await this.firstFormat();
    if (format !== undefined && first !== undefined) {
      const differs = disagreement(first, format, this.header);
      if (differs !== undefined) {
        this.refused ??= new DisagreementError(this.parts, i, differs);
        throw this.refused;
      }
    }
    if (format === undefined || this.header === "none") {
      return bomLength(await source.read(0, BOM_BYTES));
    }
    return format.dataStart;
  }

  /**
   * How part `i` reads. With a header, a part with no record in it is
   * refused, for it has no header. With none, it is undefined.
   */
  private format(i: number, source: ByteSource): Promise<Format | undefined> {
    const name = this.parts[i]!.ref.name;
    return this.header === "first" ? openFormat(name, source) : peekFormat(name, source);
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
   * that started. It stops starting them at the first failure, and that
   * failure is what it throws.
   */
  private async each(run: (i: number) => Promise<unknown> | undefined): Promise<void> {
    let next = 0;
    let stopped = false;
    const worker = async (): Promise<void> => {
      while (next < this.parts.length && !stopped) {
        try {
          await run(next++);
        } catch (err) {
          stopped = true;
          throw err;
        }
      }
    };
    const workers = Array.from({ length: Math.min(OPENING, this.parts.length) }, worker);
    const failure = (await Promise.allSettled(workers)).find((w) => w.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }

  /** A sentence about part `i` that says which part it is. */
  private named(i: number, what: string): string {
    return `${this.parts[i]!.ref.name} (part ${i + 1} of ${this.parts.length}): ${what}`;
  }

  /** failed is `err` with the part it happened to named, once. */
  private failed(i: number, err: unknown): Error {
    if (err instanceof PartError || err instanceof DisagreementError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new PartError(this.named(i, message), { cause: err });
  }
}

/** An error that already names its part, so it is not named again on the way out. */
class PartError extends Error {}

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
    const reordered = first.toSorted().every((name, at) => name === part.toSorted()[at]);
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

/** A name in quotes, so a space at its end or a tab inside it can be seen. */
function quoted(name: string): string {
  return JSON.stringify(name);
}

function same(a: Extent, b: Extent): boolean {
  return a.bytes === b.bytes && a.skip === b.skip && a.unterminated === b.unterminated;
}

function concat(pieces: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
