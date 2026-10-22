/**
 * @fileoverview Speculative chunk scanning: finds where records start in one
 * chunk of a file without knowing the state the scanner is in when the chunk
 * starts.
 *
 * The scanner in core/src/ingest/scan.ts carries one of seven states from
 * byte to byte, and that state at a chunk's first byte depends on every byte
 * before it. So a chunk is scanned from all seven states at once. Each start
 * state follows its own path. Two paths in the same state at the same byte
 * have the same future, so they merge there and continue as one. A path's
 * begins are its own until it merges, then those of the path it merged into.
 * Once the true start state is known, `trace` names exactly the begins the
 * sequential scanner would have reported for the chunk, and the state it
 * would end in.
 *
 * Three ways of stepping keep the cost near one sequential scan:
 * - With one path left, it runs the same loop as RecordScanner.push.
 * - With two left, one inside quotes and one outside, only the outside one
 *   moves: up to the next quote, the inside one stays where it is and
 *   reports nothing. Most of a chunk with no quotes is scanned this way.
 * - Otherwise every path takes one byte at a time through a table built
 *   from `transition`. In real files that is a few bytes at the chunk's
 *   start and around a quote. A file whose quotes read the same from inside
 *   and outside (`""` fields, or a run of quotes) keeps two or three paths
 *   apart for good and pays this at every quote: the worst case.
 *
 * The scanner's crAt is always the offset of the byte before the one being
 * read, so a record that starts with a CR at a chunk's last byte is reported,
 * at that offset, by the next chunk.
 *
 * This file imports nothing, so it runs as it is in a worker_threads Worker,
 * a Web Worker or the main thread.
 */

const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;
/** The first byte that is not ASCII. A separator must sit below it. */
const NON_ASCII = 0x80;

// The scanner's states, numbered as in core/src/ingest/scan.ts.
/** Between records. A blank line here is skipped. */
export const LINE = 0;
/** Between records, after a CR. It is a blank line only if LF follows. */
export const LINE_CR = 1;
/** Inside a record, at the first byte of a field. */
export const FIELD = 2;
/** Inside an unquoted field, where a quote is data. */
export const BARE = 3;
/** Inside a quoted field. */
export const QUOTED = 4;
/** Inside a quoted field, just past a quote. */
export const QUOTE_SEEN = 5;
/** Inside a quoted field, past a quote and a CR. */
export const QUOTE_CR = 6;

/** State is where the scanner is between bytes. */
export type State =
  | typeof LINE
  | typeof LINE_CR
  | typeof FIELD
  | typeof BARE
  | typeof QUOTED
  | typeof QUOTE_SEEN
  | typeof QUOTE_CR;

/** Every state, in order. Path `s` of a scan starts in state `s`. */
export const STATES: readonly State[] = [
  LINE,
  LINE_CR,
  FIELD,
  BARE,
  QUOTED,
  QUOTE_SEEN,
  QUOTE_CR,
];

/** `into` of a path that never merged. */
export const NONE = -1;

/** How many begins a path has room for before its buffer first grows. */
const FIRST_CAPACITY = 64;

/**
 * ChunkScan is what scanning one chunk returns. It is plain data, so it
 * crosses to another thread by structured clone, with `begins` transferred.
 */
export interface ChunkScan {
  /** The file offset of the chunk's first byte. */
  readonly base: number;
  /** The chunk's length in bytes. */
  readonly length: number;
  /**
   * Every path's begins, path after path, each in file order. Path `p`'s
   * are `begins[from[p]]` up to `begins[from[p] + count[p]]`.
   */
  readonly begins: Float64Array<ArrayBuffer>;
  readonly from: readonly number[];
  readonly count: readonly number[];
  /** The path each path merged into, or NONE for a path that reached the end. */
  readonly into: readonly number[];
  /**
   * How many of `into`'s begins came before the merge. The rest are this
   * path's too.
   */
  readonly joinAt: readonly number[];
  /** The state each path that reached the end is in there. */
  readonly end: readonly State[];
  readonly stats: MergeStats;
}

/** MergeStats says how the paths of one chunk scan behaved. */
export interface MergeStats {
  /**
   * Bytes into the chunk at which one path was left, or NONE when more than
   * one reached the end.
   */
  readonly merged: number;
  /** Paths that reached the end. */
  readonly survivors: number;
  /** Bytes every live path took one at a time. */
  readonly stepped: number;
}

/** Trace is one start state's part of a chunk scan. */
export interface Trace {
  /** Ranges of `begins`, as [from, to), that hold this start state's begins in order. */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
  /** The state the chunk ends in from this start state. */
  readonly end: State;
}

/**
 * separatorOf returns the byte that separates fields, refusing the same
 * separators RecordScanner does.
 */
export function separatorOf(comma: string): number {
  const sep = comma.charCodeAt(0);
  if (
    comma.length !== 1 ||
    sep >= NON_ASCII ||
    sep === QUOTE ||
    sep === LF ||
    sep === CR
  ) {
    throw new Error(`${JSON.stringify(comma)} cannot separate fields`);
  }
  return sep;
}

/** Begins is a growing list of record offsets. */
class Begins {
  buffer = new Float64Array(FIRST_CAPACITY);
  length = 0;

  push(offset: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Float64Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length++] = offset;
  }
}

/** Path is the scan of a chunk from one start state. */
class Path {
  readonly id: number;
  state: State;
  readonly begins = new Begins();
  into = NONE;
  joinAt = 0;

  constructor(id: number, state: State) {
    this.id = id;
    this.state = state;
  }
}

/**
 * scanChunk scans `chunk`, whose first byte sits at file offset `base`, from
 * every start state. `sep` is the separator byte from `separatorOf`.
 */
export function scanChunk(
  chunk: Uint8Array,
  base: number,
  sep: number,
): ChunkScan {
  const paths = STATES.map((state, id) => new Path(id, state));
  const live = paths.slice();
  let alive = live.length;
  const kinds = kindsFor(sep);
  const end = chunk.length;
  let merged = NONE;
  let stepped = 0;

  let i = 0;
  while (i < end) {
    if (alive === 1) {
      runAll(chunk, i, end, live[0]!, base, sep);
      break;
    }
    // A quote is where the outside path stopped. Every path steps over it.
    const outside = outsideOfPair(live, alive);
    if (outside !== undefined && chunk[i] !== QUOTE) {
      i = runOutside(chunk, i, end, outside, base, sep);
      continue;
    }
    const states = stepAll(live, alive, kinds[chunk[i]!]!, base + i);
    i++;
    stepped++;
    // Paths in the same state have met: keep one of each.
    if (COUNT_OF[states]! < alive) {
      alive = mergeSame(live, alive);
      if (alive === 1) merged = i;
    }
  }

  return pack(paths, base, end, { merged, survivors: alive, stepped });
}

/**
 * trace follows start state `start` through a scan: its own begins, then
 * those of each path it merged into from the point it joined.
 */
export function trace(scan: ChunkScan, start: State): Trace {
  const ranges: Array<[number, number]> = [];
  let path: number = start;
  let skip = 0;
  for (;;) {
    const from = scan.from[path]!;
    const count = scan.count[path]!;
    if (skip < count) ranges.push([from + skip, from + count]);
    const into = scan.into[path]!;
    if (into === NONE) return { ranges, end: scan.end[path]! };
    skip = scan.joinAt[path]!;
    path = into;
  }
}

/**
 * outsideOfPair returns the outside path when exactly two are live and the
 * other is inside quotes.
 */
function outsideOfPair(live: Path[], alive: number): Path | undefined {
  if (alive !== 2) return undefined;
  const a = live[0]!;
  const b = live[1]!;
  if (a.state === QUOTED && isOutside(b.state)) return b;
  if (b.state === QUOTED && isOutside(a.state)) return a;
  return undefined;
}

/**
 * isOutside says whether a state is outside any quoted field. Only a quote
 * moves the scanner from such a state into one.
 */
function isOutside(s: State): boolean {
  return s === LINE || s === LINE_CR || s === FIELD || s === BARE;
}

/**
 * mergeSame keeps the first of the live paths in each state and merges the
 * rest into it. Returns how many are left at the front of `live`.
 */
function mergeSame(live: Path[], alive: number): number {
  let kept = 0;
  for (let k = 0; k < alive; k++) {
    const path = live[k]!;
    const same = firstInState(live, kept, path.state);
    if (same === undefined) {
      live[kept++] = path;
    } else {
      path.into = same.id;
      path.joinAt = same.begins.length;
    }
  }
  return kept;
}

function firstInState(
  live: Path[],
  kept: number,
  state: State,
): Path | undefined {
  for (let m = 0; m < kept; m++) if (live[m]!.state === state) return live[m];
  return undefined;
}

// The kinds of byte the scanner tells apart.
const OTHER = 0;
const IS_LF = 1;
const IS_CR = 2;
const IS_QUOTE = 3;
const IS_SEP = 4;
const KINDS = 5;
type Kind =
  | typeof OTHER
  | typeof IS_LF
  | typeof IS_CR
  | typeof IS_QUOTE
  | typeof IS_SEP;

// What a step reports.
const NO_BEGIN = 0;
/** A record begins at this byte. */
const BEGIN_HERE = 1;
/** A record began at the CR before this byte. */
const BEGIN_AT_CR = 2;
type Begin = typeof NO_BEGIN | typeof BEGIN_HERE | typeof BEGIN_AT_CR;

/**
 * transition is one step of the scanner: the state after a byte of `kind`
 * read in state `s`, and the record it reports. It is RecordScanner.push one
 * byte at a time, and the tables below are built from it.
 */
function transition(s: State, kind: Kind): [State, Begin] {
  switch (s) {
    case LINE:
      if (kind === IS_LF) return [LINE, NO_BEGIN];
      if (kind === IS_CR) return [LINE_CR, NO_BEGIN];
      if (kind === IS_QUOTE) return [QUOTED, BEGIN_HERE];
      return [kind === IS_SEP ? FIELD : BARE, BEGIN_HERE];
    case LINE_CR:
      if (kind === IS_LF) return [LINE, NO_BEGIN];
      // The CR was the first byte of an unquoted field.
      return [kind === IS_SEP ? FIELD : BARE, BEGIN_AT_CR];
    case FIELD:
    case BARE:
      if (kind === IS_LF) return [LINE, NO_BEGIN];
      // A quote opens a quoted field only as the field's first byte.
      if (kind === IS_QUOTE) return [s === FIELD ? QUOTED : BARE, NO_BEGIN];
      return [kind === IS_SEP ? FIELD : BARE, NO_BEGIN];
    case QUOTED:
      return [kind === IS_QUOTE ? QUOTE_SEEN : QUOTED, NO_BEGIN];
    case QUOTE_SEEN:
      if (kind === IS_QUOTE) return [QUOTED, NO_BEGIN];
      if (kind === IS_SEP) return [FIELD, NO_BEGIN];
      if (kind === IS_LF) return [LINE, NO_BEGIN];
      if (kind === IS_CR) return [QUOTE_CR, NO_BEGIN];
      return [QUOTED, NO_BEGIN]; // a bare quote, which LazyQuotes keeps
    case QUOTE_CR:
      if (kind === IS_LF) return [LINE, NO_BEGIN];
      return [kind === IS_QUOTE ? QUOTE_SEEN : QUOTED, NO_BEGIN];
    default:
      return unknownState(s);
  }
}

/** The next state, and the begin reported, for each state and kind of byte. */
const NEXT = new Uint8Array(STATES.length * KINDS);
const BEGIN = new Uint8Array(STATES.length * KINDS);
for (const s of STATES) {
  for (const kind of [OTHER, IS_LF, IS_CR, IS_QUOTE, IS_SEP] as const) {
    const [next, begin] = transition(s, kind);
    NEXT[s * KINDS + kind] = next;
    BEGIN[s * KINDS + kind] = begin;
  }
}

/** Byte values. */
const BYTE_VALUES = 256;

/** kindsFor returns the kind of every byte value, for separator `sep`. */
function kindsFor(sep: number): Uint8Array {
  const kinds = new Uint8Array(BYTE_VALUES).fill(OTHER);
  kinds[LF] = IS_LF;
  kinds[CR] = IS_CR;
  kinds[QUOTE] = IS_QUOTE;
  kinds[sep] = IS_SEP;
  return kinds;
}

/** How many states are set in a set of states held as bits. */
const COUNT_OF = Uint8Array.from({ length: 1 << STATES.length }, (_, set) => {
  let count = 0;
  for (let bits = set; bits !== 0; bits >>= 1) count += bits & 1;
  return count;
});

/**
 * stepAll moves every live path past one byte of `kind` at file offset `at`.
 * Returns the set of states they are in, as bits.
 */
function stepAll(
  live: Path[],
  alive: number,
  kind: number,
  at: number,
): number {
  let states = 0;
  for (let k = 0; k < alive; k++) {
    const path = live[k]!;
    const entry = path.state * KINDS + kind;
    const begin = BEGIN[entry];
    if (begin === BEGIN_HERE) path.begins.push(at);
    else if (begin === BEGIN_AT_CR) path.begins.push(at - 1);
    path.state = NEXT[entry] as State;
    states |= 1 << path.state;
  }
  return states;
}

/**
 * runOutside moves an outside path from `from` until the next quote or the
 * chunk's end, and returns where it stopped. The quote is left unread.
 */
function runOutside(
  chunk: Uint8Array,
  from: number,
  end: number,
  path: Path,
  base: number,
  sep: number,
): number {
  const out = path.begins;
  let s = path.state;
  let i = from;

  while (i < end) {
    const b = chunk[i]!;
    if (b === QUOTE) break;
    switch (s) {
      case LINE:
        if (b === LF) break;
        if (b === CR) {
          s = LINE_CR;
          break;
        }
        out.push(base + i);
        s = b === sep ? FIELD : BARE;
        break;

      case LINE_CR:
        if (b === LF) {
          s = LINE;
          break;
        }
        out.push(base + i - 1);
        s = b === sep ? FIELD : BARE;
        break;

      case FIELD:
      case BARE: {
        let j = i;
        let c = b;
        while (c !== LF && c !== QUOTE) {
          if (++j === end) break;
          c = chunk[j]!;
        }
        if (j === end || c === QUOTE) {
          // Stop short of the quote, in the state the byte before it left.
          s = j === i ? s : chunk[j - 1] === sep ? FIELD : BARE;
          i = j;
          continue;
        }
        s = LINE;
        i = j;
        break;
      }

      case QUOTED:
      case QUOTE_SEEN:
      case QUOTE_CR:
        throw new Error(`state ${s} is inside quotes`);
      default:
        return unknownState(s);
    }
    i++;
  }

  path.state = s;
  return i;
}

/**
 * runAll moves the one live path from `from` to `end`. It is
 * RecordScanner.push with its begins written to a list.
 */
function runAll(
  chunk: Uint8Array,
  from: number,
  end: number,
  path: Path,
  base: number,
  sep: number,
): void {
  const out = path.begins;
  let s = path.state;
  let i = from;

  while (i < end) {
    const b = chunk[i]!;
    switch (s) {
      case LINE:
        if (b === LF) break;
        if (b === CR) {
          s = LINE_CR;
          break;
        }
        out.push(base + i);
        s = b === QUOTE ? QUOTED : b === sep ? FIELD : BARE;
        break;

      case LINE_CR:
        if (b === LF) {
          s = LINE;
          break;
        }
        out.push(base + i - 1);
        s = b === sep ? FIELD : BARE;
        break;

      case FIELD:
      case BARE: {
        let j = i;
        let c = b;
        while (c !== LF && c !== QUOTE) {
          if (++j === end) break;
          c = chunk[j]!;
        }
        if (j === end) {
          s = j === i ? s : chunk[j - 1] === sep ? FIELD : BARE;
          i = j;
          continue;
        }
        if (c === LF) s = LINE;
        else if (j === i ? s === FIELD : chunk[j - 1] === sep) s = QUOTED;
        else s = BARE;
        i = j;
        break;
      }

      case QUOTED: {
        let j = i;
        while (chunk[j] !== QUOTE) {
          if (++j === end) break;
        }
        if (j === end) {
          i = j;
          continue;
        }
        s = QUOTE_SEEN;
        i = j;
        break;
      }

      case QUOTE_SEEN:
        if (b === QUOTE) s = QUOTED;
        else if (b === sep) s = FIELD;
        else if (b === LF) s = LINE;
        else if (b === CR) s = QUOTE_CR;
        else s = QUOTED;
        break;

      case QUOTE_CR:
        if (b === LF) s = LINE;
        else s = b === QUOTE ? QUOTE_SEEN : QUOTED;
        break;
      default:
        return unknownState(s);
    }
    i++;
  }

  path.state = s;
}

/** pack lays every path's begins end to end in one buffer that can be transferred. */
function pack(
  paths: Path[],
  base: number,
  length: number,
  stats: MergeStats,
): ChunkScan {
  let total = 0;
  for (const path of paths) total += path.begins.length;
  const begins = new Float64Array(total);
  const from: number[] = [];
  let at = 0;
  for (const path of paths) {
    from.push(at);
    begins.set(path.begins.buffer.subarray(0, path.begins.length), at);
    at += path.begins.length;
  }
  return {
    base,
    length,
    begins,
    from,
    count: paths.map((path) => path.begins.length),
    into: paths.map((path) => path.into),
    joinAt: paths.map((path) => path.joinAt),
    end: paths.map((path) => path.state),
    stats,
  };
}

function unknownState(s: never): never {
  throw new Error(`unknown scanner state ${String(s)}`);
}
