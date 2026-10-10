// Several files read as one: the ByteSource of a multi-file source.
//
// The parts are joined end to end. The first part is included whole. Each
// later part is included from its first data row, so its header is skipped.
// A part whose last byte is something other than a newline gets a virtual
// one, so its last row and the next part's first stay separate rows. Each
// part is opened through the handlers given, so a part can be on a disk, in
// a bucket or in memory.

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
// Type only.
import type { Provider } from "../plugin/index.ts";

/**
 * Whether the parts have a header row. With "first", the first part's header
 * names the columns and every later part's header is skipped. With "none",
 * every line of every part is a row.
 */
export type { HeaderMode };

/**
 * Extent is what the join needs to know about one part to place it. It
 * depends on the part alone.
 */
export interface Extent {
  /** The part's size. */
  bytes: number;
  /**
   * How many bytes at the start of the part the join leaves out: a later
   * part's header, or its byte order mark. 0 for the first part.
   */
  skip: number;
  /** Whether its last byte is something other than a newline. */
  unterminated: boolean;
}

/**
 * Part is one file of a multi-file source. A part with an `extent` is opened
 * by the first read that needs it, and is checked against the extent then. A
 * part that came bare is opened and measured when the source opens.
 */
export interface Part {
  /** Where the part is, and which version where a save recorded one. */
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
   * One past the last, the virtual newline included. A part that gives zero
   * bytes has `end` equal to `start`.
   */
  end: number;
  /** How many bytes of the part come before the first one it gives. */
  skip: number;
  /** Whether the byte at `end - 1` is a virtual newline, added after the
   * part's last byte. */
  newline: boolean;
}

/**
 * PartMap says which part every byte of the join came from. A row belongs to
 * the part its first byte is in.
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
 * MultiSource is the parts read as one ByteSource, with the part map and
 * extents beside it. Its own `version` is absent. `versions` gives each
 * part's.
 */
export interface MultiSource extends ByteSource {
  /** Where each part sits in the join. */
  readonly map: PartMap;
  /** Each part's extent, in order. A save records them so the next open can
   * skip opening the parts. */
  readonly extents: readonly Extent[];
  /**
   * Each part's version, in order, or undefined where its place leaves it
   * out. Opens the parts that are still to open.
   */
  versions(): Promise<Array<string | undefined>>;
}

/** ColumnDifference is one column a later part names differently from the
 * first. */
export interface ColumnDifference {
  /** Which column, counting from 0. */
  column: number;
  /** What the first part calls it. */
  first: string;
  /** What this part calls it. */
  part: string;
}

/** NamedColumn is a column only one of two parts has. */
export interface NamedColumn {
  /** Which column of the part that has it, counting from 0. */
  column: number;
  name: string;
}

/**
 * Disagreement is one way a later part reads differently from the first.
 * `first` is the first part's side and `part` the later part's. When a header
 * differs in several ways, the most specific kind is reported.
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
  /** Columns this part adds beyond the first, the rest in order. */
  | { kind: "extra"; columns: NamedColumn[] }
  /** Headers of different lengths, and the first column that differs. */
  | { kind: "columns"; first: number; part: number; column: ColumnDifference }
  /** Under a "none" header: first rows with different numbers of fields. */
  | { kind: "fields"; first: number; part: number };

/**
 * DisagreementError is thrown when a part reads differently from the first
 * part: as the source opens, or by the first read that reaches a part
 * that came with an extent, and by every read after that.
 */
export class DisagreementError extends Error {
  /** Which part, counting from 0. */
  readonly part: number;
  /** The part's name. */
  readonly partName: string;
  /** The first part's name. */
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

/** How many columns an error names before counting the rest. */
const COLUMNS_NAMED = 3;

const LF = 0x0a;

/** How many bytes the virtual newline is. */
const NEWLINE_BYTES = 1;

/** How many bytes a byte order mark can take. */
const BOM_BYTES = 3;

/** How many parts are opened at once when several are opened together. */
const OPENING = 4;

/**
 * partMap lays the parts end to end. Each gives what is left after `skip`. A
 * part that gives something, is unterminated and has a part after it is
 * followed by a virtual newline.
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
      // Binary search for the last span that starts at or before the offset.
      // An empty span starts where the next one does, so the search lands
      // past it.
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
 * A part that came bare is opened and measured here. One with an extent is
 * opened by the first read that reaches it. With a header, a later part is
 * checked against the first part's header when it is opened.
 *
 * Every error names the part. A part that disagrees with the first throws a
 * DisagreementError: found at open, every part is closed again; found by a
 * read, every read after it throws the same error.
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

  /** The bytes of one span from `from` up to `to`, both joined offsets inside
   * it. */
  async function piece(span: Span, from: number, to: number): Promise<Uint8Array> {
    const body = span.end - (span.newline ? NEWLINE_BYTES : 0);
    // Only the virtual newline is wanted, and it is made here.
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

      // Pieces of each span in order. A read inside one part returns that
      // part's bytes as they came.
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
 * Parts opens each part once, when first needed, and checks it against what
 * the source says of it.
 */
class Parts {
  /** Each part's open, once asked for. */
  private readonly sources: Array<Promise<ByteSource> | undefined>;
  /** Each part's extent: the one it came with, or the one its open measured. */
  private readonly extents: Array<Extent | undefined>;
  /**
   * How the first part reads. Undefined where it holds zero records, which
   * only a "none" header allows.
   */
  private first: Promise<Format | undefined> | undefined;
  /** The disagreement that refuses the whole source, once found. */
  private refused: DisagreementError | undefined;
  /** Whether `close` has been called, after which every open and read is
   * refused. */
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

  /** measure opens every part that came bare. */
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

  /** `length` bytes of part `i` from `offset`, all of which its extent says it
   * has. */
  async read(i: number, offset: number, length: number): Promise<Uint8Array> {
    if (this.refused !== undefined) throw this.refused;
    const source = await this.source(i);
    // Closed while the part was opening.
    if (this.closed) throw new ClosedError();
    let bytes: Uint8Array;
    try {
      bytes = await source.read(offset, length);
    } catch (err) {
      throw this.failed(i, err);
    }
    // A short read would shift every row after it.
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
   * close closes every opened part, waiting for any still opening. After it,
   * every open is refused and every read throws ClosedError.
   */
  async close(): Promise<void> {
    this.closed = true;
    const opening = this.sources.flatMap((s) => (s === undefined ? [] : [s]));
    for (let i = 0; i < this.sources.length; i++) this.sources[i] = undefined;
    const settled = await Promise.allSettled(opening);
    await Promise.all(settled.flatMap((o) => (o.status === "fulfilled" ? [o.value.close()] : [])));
  }

  /**
   * Part `i`, opened the first time it is asked for. A failed open is
   * forgotten, so the next read tries again. After close, it rejects.
   */
  private source(i: number): Promise<ByteSource> {
    if (this.closed) return Promise.reject(new ClosedError());
    return (this.sources[i] ??= this.open(i).catch((err: unknown) => {
      this.sources[i] = undefined;
      throw this.failed(i, err);
    }));
  }

  /** open opens part `i`, measures it, and checks it against the extent it
   * came with. */
  private async open(i: number): Promise<ByteSource> {
    const ref = this.parts[i]!.ref;
    const source = await openWith(this.handlers, ref);
    try {
      const was = this.extents[i];
      // Where the part came with an extent and a saved version, and the place
      // reports a different version, the part is refused before it is read.
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
   * skip is how many bytes at the start of part `i` the join leaves out.
   *
   * The first part and an empty part skip 0 bytes. A later part is checked
   * against the first part's format, then skipped up to its first data row,
   * which under a "none" header is just a byte order mark. A part holding
   * zero records skips its byte order mark only.
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
    // A part holding zero records has only a byte order mark to skip.
    if (format === undefined) return bomLength(await source.read(0, BOM_BYTES));
    return format.dataStart;
  }

  /**
   * formatOrDiffers is `format`, with an unsupported encoding reported as an
   * encoding disagreement against the first part.
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
   * refuse throws a DisagreementError for part `i`. The one kept on `refused`
   * is for the earliest part found to disagree, so the same parts give the
   * same error on every open.
   */
  private refuse(i: number, differs: Disagreement): never {
    const refusal = new DisagreementError(this.parts, i, differs);
    if (this.refused === undefined || i < this.refused.part) this.refused = refusal;
    throw refusal;
  }

  /**
   * How part `i` reads, or undefined where it holds zero records. The first
   * part of a source with a header row is read with openFormat, which throws
   * on an empty file. Every other part is read with peekFormat.
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
   * that started. It stops starting new ones after the first failure, and
   * throws the failure of the earliest part that failed.
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

  /** failed wraps `err` in a PartError naming part `i`. An error that
   * already names one is returned as it is. */
  private failed(i: number, err: unknown): Error {
    if (err instanceof PartError || err instanceof DisagreementError) return err;
    // A closed source is a failure of the whole, passed through as it is.
    if (err instanceof ClosedError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new PartError(this.named(i, message), { cause: err });
  }
}

/** An error that already names its part. */
class PartError extends Error {}

/** The refusal of a read that reaches a source after it was closed. */
class ClosedError extends Error {
  constructor() {
    super("the source was closed");
  }
}

/**
 * disagreement says how `part` reads differently from `first`, or undefined
 * where they agree. Encoding is checked first, then delimiter, then the
 * header, or under a "none" header, the field count of the first row.
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
    // Each header is sorted once. A header can be thousands of columns wide.
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
  // The shorter header is more than the longer with columns taken out, so
  // one of the columns they both have differs.
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

/** said is a disagreement as the rest of a sentence that starts with the
 * part's name. */
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

/** partLabel names part `i` for a person: its file, and its place in the
 * list. */
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

/** The label for a source of several files, for errors. */
const LABEL = "several files as one";

/** Every source multiFiles opened, so multiOf can tell one from any other
 * ByteSource. */
const joined = new WeakMap<ByteSource, MultiSource>();

/**
 * multiFiles opens a ref with parts as one file. It claims every ref that has
 * `parts`, and opens each part through `handlers`. What it opens is a
 * MultiSource, which `multiOf` gets back from the ByteSource.
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
      // A ref may have come over a channel or out of a file, so a nested
      // PartsRef is checked for at run time.
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
 * multiOf is the MultiSource behind a source multiFiles opened, or undefined
 * for any other source.
 */
export function multiOf(source: ByteSource): MultiSource | undefined {
  return joined.get(source);
}

/**
 * multiProvider is the several-files-as-one provider over the providers
 * given: multiFiles over their handlers, for opening only.
 */
export function multiProvider(providers: readonly Provider[]): Provider {
  return { name: "multi", label: LABEL, files: multiFiles(providers.map((p) => p.files)) };
}
