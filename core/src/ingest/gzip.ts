/**
 * @fileoverview Inflates gzip: a whole file, a head up to a limit, or one
 * pass through a file that keeps checkpoints a later read resumes from.
 *
 * All three run pako's low-level zlib API through one class, Members, which
 * inflates gzip members one after another and stops at every deflate block
 * boundary. A checkpoint is such a boundary with the 32 KB decoded before it,
 * as Mark Adler's zran keeps, or a member start, which needs no window. A
 * read resumes from one as raw deflate, with the window as its dictionary,
 * unless the cursor the last read left is nearer.
 */

import {
  ZStream,
  Z_BLOCK,
  Z_BUF_ERROR,
  Z_OK,
  Z_STREAM_END,
  zlibInflate,
  zlibInflateInit2,
  zlibInflateReset2,
  zlibInflateSetDictionary,
} from 'pako';

import type { ByteSource } from '@store';

/** Decoded bytes between checkpoints, before any thinning. */
export const CHECKPOINT_SPAN = 16 << 20;
/** Window bytes a file read alone may hold. */
export const CHECKPOINT_BUDGET = 32 << 20;
/** How far back a deflate reference reaches: the bytes a window holds. */
export const WINDOW_BYTES = 32 << 10;
/** Decoded spans a file read alone keeps for reads behind its cursor. */
export const SPANS_KEPT = 1;
/**
 * Stored bytes inflated between turns of the event loop: a pass pushes this
 * many at a time, and a read asks its source for this many.
 */
export const INFLATE_SLICE_BYTES = 1 << 20;

/** zlib's window bits for a 32 KB window. */
const MAX_WINDOW_BITS = 15;
/** Added to the window bits, it has zlib read a gzip wrapper and only that. */
const GZIP_WRAPPER = 16;
/** Window bits that have zlib read a gzip wrapper. */
const GZIP_WINDOW_BITS = MAX_WINDOW_BITS + GZIP_WRAPPER;
/** Negative window bits have zlib read raw deflate, with no wrapper. */
const RAW_WINDOW_BITS = -MAX_WINDOW_BITS;
/** The data_type flag of an inflate that stopped at a block boundary. */
const BLOCK_BOUNDARY = 0x80;
/** The data_type flag of a member whose last block has been read. */
const LAST_BLOCK = 0x40;
/** The data_type bits that count the unused bits of the last byte read. */
const UNUSED_BITS = 0x07;
const BITS_PER_BYTE = 8;
/** Decoded bytes inflated past the window before the buffer slides. */
const PIECE_BYTES = 256 << 10;
/** No bytes: the piece of a step that read padding alone, an empty window. */
const NONE = new Uint8Array(0);
/** A gzip member's trailer: its CRC, then its decoded length. */
const TRAILER_BYTES = 8;
/**
 * An empty dynamic block that is not the last, low bit first. It is 95 bits
 * long, an odd count, so it changes the parity of a preface.
 */
const EMPTY_DYNAMIC = [4, 0xe0, 0x81, 8, 0, 0, 0, 0, 0x20, 0xa8, 0xab, 0x1f];
const EMPTY_DYNAMIC_BITS = 95;
/** An empty fixed block that is not the last: its header, then its end. */
const EMPTY_FIXED = 0b10;
const EMPTY_FIXED_BITS = 10;

/**
 * BrokenStream is thrown for a compressed stream that is damaged or cut
 * short. It carries the stored offset inflate had read to when it found so.
 */
export class BrokenStream extends Error {
  readonly at: number;

  constructor(at: number, reason: string) {
    super(`the compressed stream is broken at byte ${at}: ${reason}`);
    this.name = 'BrokenStream';
    this.at = at;
  }
}

/** Checkpoint is a place a read can resume inflating from. */
export interface Checkpoint {
  /** The stored byte the next deflate block starts in. */
  readonly stored: number;
  /** The bits of that byte already used, 0 to 7. */
  readonly bits: number;
  /** The decoded offset it resumes at. */
  readonly decoded: number;
  /** The decoded bytes before it in its member, up to WINDOW_BYTES. */
  readonly window: Uint8Array;
}

/** InflaterBudget is the memory an inflater may keep. */
export interface InflaterBudget {
  /**
   * Window bytes, a whole window for each checkpoint, a member start's too.
   * Past it every other checkpoint goes and the span doubles.
   */
  readonly windows: number;
  /** Decoded spans kept for reads behind the cursor. */
  readonly spans: number;
}

/** ALONE is the budget of a file read alone. */
export const ALONE: InflaterBudget = {
  windows: CHECKPOINT_BUDGET,
  spans: SPANS_KEPT,
};

/** partBudget is the budget of each of `openParts` parts read as one. */
export function partBudget(openParts: number): InflaterBudget {
  return { windows: Math.floor(CHECKPOINT_BUDGET / openParts), spans: 0 };
}

/**
 * Inflater inflates a compressed file once, from the start, and keeps the
 * checkpoints a read resumes from.
 */
export interface Inflater {
  /**
   * Feeds the next stored bytes, from 0 in order. `out` gets each decoded
   * piece and its decoded offset; the piece is good until `out` returns.
   * Throws BrokenStream.
   */
  push(
    stored: Uint8Array,
    out: (decoded: Uint8Array, at: number) => void,
  ): void;
  /**
   * The stored bytes ended. Returns the decoded size; throws BrokenStream for
   * a stream cut short.
   */
  end(): number;
  /** The checkpoints kept so far, in decoded order. */
  checkpoints(): readonly Checkpoint[];
  /**
   * Up to `length` decoded bytes from `offset`, which push has passed, and
   * fewer only at the end of the stream. It carries on from where the last
   * read stopped, or resumes from the checkpoint before `offset` when that
   * is nearer. Throws BrokenStream.
   */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Stored is where an inflater reads stored bytes back from. */
export type Stored = Pick<ByteSource, 'read'>;

/** Where a deflate block starts in the stored bytes. */
type BlockStart = Pick<Checkpoint, 'stored' | 'bits'>;

/**
 * Members inflates gzip members one after another. Each step is one call to
 * zlib, which stops at a block boundary, a full buffer or the input's end.
 * Zero bytes after a member are padding.
 */
class Members {
  private readonly z = new ZStream();
  /** Decoded bytes, the last WINDOW_BYTES of the earlier ones first. */
  private readonly buffer = new Uint8Array(WINDOW_BYTES + PIECE_BYTES);
  /** The stored offset of the input's first byte. */
  private base = 0;
  /** Decoded bytes so far. */
  decoded = 0;
  /** The decoded offset the current member starts at. */
  member = 0;
  /** The last member has ended, and no other has begun. */
  ended = false;
  /**
   * Trailer bytes to pass over once the member ends. zlib reads a trailer
   * itself, except after a member resumed as raw deflate.
   */
  private trailer = 0;

  constructor(windowBits = GZIP_WINDOW_BITS) {
    zlibInflateInit2(this.z, windowBits);
    this.z.output = this.buffer;
    this.z.next_out = WINDOW_BYTES;
    this.z.avail_out = PIECE_BYTES;
  }

  /**
   * Members resumed at a checkpoint, given the stored bytes from the byte it
   * starts in. The rest of its member is raw deflate, with the checkpoint's
   * window as the dictionary and a preface for the bits not yet used.
   */
  static resume(point: Checkpoint, stored: Uint8Array): Members {
    const members = new Members(RAW_WINDOW_BITS);
    zlibInflateSetDictionary(members.z, point.window);
    members.decoded = point.decoded;
    members.trailer = TRAILER_BYTES;
    if (point.bits === 0) {
      members.feed(stored, point.stored);
      return members;
    }
    const lead = preface(stored[0]!, point.bits);
    const rest = stored.subarray(1);
    const input = joined([lead, rest], lead.length + rest.length);
    members.feed(input, point.stored + 1 - lead.length);
    return members;
  }

  /** The stored offset inflate has read to. */
  get at(): number {
    return this.base + this.z.next_in;
  }

  /** True once every byte fed has been read. */
  get hungry(): boolean {
    return this.z.avail_in === 0;
  }

  /**
   * Hands over the next stored bytes, once the last have been read. They
   * start at stored offset `at`, by default where the last ended.
   */
  feed(stored: Uint8Array, at = this.at): void {
    this.base = at;
    this.z.input = stored;
    this.z.next_in = 0;
    this.z.avail_in = stored.length;
  }

  /** Inflates a step. The piece it returns is good until the next step. */
  step(): Uint8Array {
    const z = this.z;
    if (this.ended) {
      const trailer = Math.min(this.trailer, z.avail_in);
      this.skip(trailer);
      this.trailer -= trailer;
      while (z.avail_in > 0 && z.input[z.next_in] === 0) this.skip(1);
      if (z.avail_in === 0) return NONE;
      zlibInflateReset2(z, GZIP_WINDOW_BITS);
      this.ended = false;
      this.member = this.decoded;
    }
    if (z.avail_out === 0) {
      this.buffer.copyWithin(0, PIECE_BYTES);
      z.next_out = WINDOW_BYTES;
      z.avail_out = PIECE_BYTES;
    }
    const from = z.next_out;
    const status = zlibInflate(z, Z_BLOCK);
    if (status !== Z_OK && status !== Z_BUF_ERROR && status !== Z_STREAM_END) {
      throw new BrokenStream(this.at, z.msg || `zlib returned ${status}`);
    }
    this.ended = status === Z_STREAM_END;
    this.decoded += z.next_out - from;
    return this.buffer.subarray(from, z.next_out);
  }

  /**
   * Where the next block starts, when the last step stopped at a boundary
   * before its member's last block.
   */
  boundary(): BlockStart | undefined {
    const type = this.z.data_type;
    if (
      this.ended ||
      (type & (BLOCK_BOUNDARY | LAST_BLOCK)) !== BLOCK_BOUNDARY
    ) {
      return undefined;
    }
    const unused = type & UNUSED_BITS;
    if (unused === 0) return { stored: this.at, bits: 0 };
    return { stored: this.at - 1, bits: BITS_PER_BYTE - unused };
  }

  /** A copy of this member's decoded bytes so far, up to WINDOW_BYTES. */
  window(): Uint8Array {
    const length = Math.min(WINDOW_BYTES, this.decoded - this.member);
    if (length === 0) return NONE;
    return this.buffer.slice(this.z.next_out - length, this.z.next_out);
  }

  /** Throws BrokenStream unless the stored bytes ended with a member. */
  end(): void {
    if (!this.ended || this.trailer > 0) {
      throw new BrokenStream(this.at, 'it ends mid-member');
    }
  }

  /** Passes over `count` bytes of input. */
  private skip(count: number): void {
    this.z.next_in += count;
    this.z.avail_in -= count;
  }
}

/**
 * Deflate input that decodes to nothing and leaves inflate holding the bits
 * of `byte` after the first `used`, as zran's inflatePreface does. Empty
 * blocks bring the input to a byte boundary once those bits follow.
 */
function preface(byte: number, used: number): Uint8Array {
  const unused = BITS_PER_BYTE - used;
  const bits: number[] = [];
  const append = (value: number, count: number): void => {
    for (let i = 0; i < count; i++) bits.push((value >> i) & 1);
  };
  if (unused % 2 === 1) {
    for (const value of EMPTY_DYNAMIC) {
      append(value, Math.min(BITS_PER_BYTE, EMPTY_DYNAMIC_BITS - bits.length));
    }
  }
  while ((bits.length + unused) % BITS_PER_BYTE !== 0) {
    append(EMPTY_FIXED, EMPTY_FIXED_BITS);
  }
  append(byte >> used, unused);
  const out = new Uint8Array(bits.length / BITS_PER_BYTE);
  bits.forEach((bit, i) => {
    out[Math.floor(i / BITS_PER_BYTE)]! |= bit << (i % BITS_PER_BYTE);
  });
  return out;
}

/** Lays pieces end to end, up to `length` bytes. */
function joined(pieces: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    if (at >= length) break;
    out.set(piece.subarray(0, length - at), at);
    at += piece.length;
  }
  return out;
}

/**
 * gunzipWhole inflates every member of a gzip file held in memory. Throws
 * BrokenStream.
 */
export function gunzipWhole(stored: Uint8Array): Uint8Array {
  const members = new Members();
  const pieces: Uint8Array[] = [];
  members.feed(stored);
  while (!members.hungry) pieces.push(members.step().slice());
  members.end();
  return joined(pieces, members.decoded);
}

/**
 * inflateHead inflates the front of a gzip file up to `limit` decoded bytes.
 * The stored bytes may be cut anywhere. `ended` is true when they held whole
 * members and decoded within the limit. Throws BrokenStream for damage.
 */
export function inflateHead(
  stored: Uint8Array,
  limit: number,
): { readonly bytes: Uint8Array; readonly ended: boolean } {
  const members = new Members();
  const pieces: Uint8Array[] = [];
  members.feed(stored);
  while (!members.hungry && members.decoded <= limit) {
    pieces.push(members.step().slice());
  }
  return {
    bytes: joined(pieces, Math.min(members.decoded, limit)),
    ended: members.hungry && members.ended && members.decoded <= limit,
  };
}

/**
 * gzipInflater inflates a gzip file once. It keeps a checkpoint at the first
 * block boundary, a member start, then at each one at least `span` past the
 * last checkpoint. A read inflates again from `stored`.
 */
export function gzipInflater(
  stored: Stored,
  budget: InflaterBudget,
  span: number = CHECKPOINT_SPAN,
): Inflater {
  return new GzipInflater(stored, budget, span);
}

/** Piece is a decoded piece and the decoded offset it starts at. */
interface Piece {
  readonly at: number;
  readonly bytes: Uint8Array;
}

/**
 * Cursor inflates from a checkpoint on, reading the stored bytes as it needs
 * them. It holds the piece it inflated last.
 */
class Cursor {
  /** The piece inflated last, good until the next step. */
  private last: Piece;
  private readonly stored: Stored;
  private readonly members: Members;
  /** The stored offset of the next bytes to read. */
  private next: number;

  private constructor(stored: Stored, members: Members, next: number) {
    this.stored = stored;
    this.members = members;
    this.next = next;
    this.last = { at: members.decoded, bytes: NONE };
  }

  /** A cursor resumed at `point`. */
  static async resume(stored: Stored, point: Checkpoint): Promise<Cursor> {
    const bytes = await stored.read(point.stored, INFLATE_SLICE_BYTES);
    const members = Members.resume(point, bytes);
    return new Cursor(stored, members, point.stored + bytes.length);
  }

  /** The decoded offset of the first byte held. */
  get from(): number {
    return this.last.at;
  }

  /** The decoded offset it has inflated to. */
  get to(): number {
    return this.members.decoded;
  }

  /**
   * Up to `length` bytes from `offset`, which is at or past `from`, and
   * fewer only at the end of the stream.
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let got = 0;
    const copy = ({ at, bytes }: Piece): void => {
      const skip = offset + got - at;
      if (got === length || skip >= bytes.length) return;
      const part = bytes.subarray(skip, skip + length - got);
      out.set(part, got);
      got += part.length;
    };
    copy(this.last);
    while (got < length && (await this.step())) copy(this.last);
    return out.subarray(0, got);
  }

  /** Inflates the next piece. False at the end of the stream. */
  private async step(): Promise<boolean> {
    while (this.members.hungry) {
      const bytes = await this.stored.read(this.next, INFLATE_SLICE_BYTES);
      if (bytes.length === 0) {
        this.members.end();
        return false;
      }
      this.next += bytes.length;
      this.members.feed(bytes);
    }
    this.last = { at: this.members.decoded, bytes: this.members.step() };
    return true;
  }
}

/**
 * GzipInflater holds its checkpoints under the budget: when one more would
 * pass it, every other checkpoint goes and the span doubles.
 */
class GzipInflater implements Inflater {
  private readonly members = new Members();
  private kept: Checkpoint[] = [];
  /**
   * The checkpoints the budget holds, a whole window for each, and at least
   * the first, which a read before any other resumes from.
   */
  private readonly most: number;
  /** Where the last read left off, which the next carries on from. */
  private cursor: Cursor | undefined;
  /** The last read, which the next waits for, since they share the cursor. */
  private reading: Promise<void> = Promise.resolve();

  private readonly stored: Stored;
  /** The decoded bytes between checkpoints, which thinning doubles. */
  private span: number;

  constructor(stored: Stored, budget: InflaterBudget, span: number) {
    this.stored = stored;
    this.span = span;
    this.most = Math.max(1, Math.floor(budget.windows / WINDOW_BYTES));
  }

  push(
    stored: Uint8Array,
    out: (decoded: Uint8Array, at: number) => void,
  ): void {
    const members = this.members;
    members.feed(stored);
    while (!members.hungry) {
      const at = members.decoded;
      const piece = members.step();
      if (piece.length > 0) out(piece, at);
      const start = members.boundary();
      if (start !== undefined) this.reached(start);
    }
  }

  end(): number {
    this.members.end();
    return this.members.decoded;
  }

  checkpoints(): readonly Checkpoint[] {
    return this.kept;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    const read = this.reading.then(async () => {
      const cursor = await this.cursorFor(offset);
      return cursor.read(offset, length);
    });
    this.reading = read.then(
      () => undefined,
      () => {
        // A read that failed may have left its cursor part way through a step.
        this.cursor = undefined;
      },
    );
    return read;
  }

  /**
   * The cursor, which starts again from the checkpoint before `offset` when
   * `offset` is behind what it holds or that checkpoint is past it.
   */
  private async cursorFor(offset: number): Promise<Cursor> {
    const point = this.before(offset);
    const cursor = this.cursor;
    if (cursor && cursor.from <= offset && point.decoded <= cursor.to) {
      return cursor;
    }
    this.cursor = await Cursor.resume(this.stored, point);
    return this.cursor;
  }

  /** The last checkpoint at or before a decoded offset. */
  private before(offset: number): Checkpoint {
    let low = 0;
    let high = this.kept.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.kept[middle]!.decoded <= offset) low = middle;
      else high = middle - 1;
    }
    const point = this.kept[low];
    if (point === undefined) throw new RangeError('no checkpoint to read from');
    return point;
  }

  /** Keeps a block boundary a span past the last checkpoint, or the first. */
  private reached(start: BlockStart): void {
    const decoded = this.members.decoded;
    const last = this.kept.at(-1);
    if (last !== undefined && decoded - last.decoded < this.span) return;
    this.kept.push({ ...start, decoded, window: this.members.window() });
    while (this.kept.length > this.most) this.thin();
  }

  /** Drops every other checkpoint after the first, and doubles the span. */
  private thin(): void {
    this.kept = this.kept.filter((_, i) => i % 2 === 0);
    this.span *= 2;
  }
}
