/**
 * @fileoverview Inflates gzip: a whole file, a head up to a limit, or one
 * pass through a file that keeps checkpoints a later read resumes from.
 *
 * All three run pako's low-level zlib API through one class, Members, which
 * inflates gzip members one after another and stops at every deflate block
 * boundary. A checkpoint is such a boundary with the 32 KB decoded before it,
 * as Mark Adler's zran keeps, or a member start, which needs no window.
 */

import {
  ZStream,
  Z_BLOCK,
  Z_BUF_ERROR,
  Z_OK,
  Z_STREAM_END,
  zlibInflate,
  zlibInflateInit2,
  zlibInflateReset,
} from 'pako';

/** Decoded bytes between checkpoints, before any thinning. */
export const CHECKPOINT_SPAN = 16 << 20;
/** Window bytes a file read alone may hold. */
export const CHECKPOINT_BUDGET = 32 << 20;
/** How far back a deflate reference reaches: the bytes a window holds. */
export const WINDOW_BYTES = 32 << 10;
/** Decoded spans a file read alone keeps for reads behind its cursor. */
export const SPANS_KEPT = 1;

/** zlib's window bits for a 32 KB window. */
const MAX_WINDOW_BITS = 15;
/** Added to the window bits, it has zlib read a gzip wrapper and only that. */
const GZIP_WRAPPER = 16;
/** Window bits that have zlib read a gzip wrapper. */
const GZIP_WINDOW_BITS = MAX_WINDOW_BITS + GZIP_WRAPPER;
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
}

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

  constructor() {
    zlibInflateInit2(this.z, GZIP_WINDOW_BITS);
    this.z.output = this.buffer;
    this.z.next_out = WINDOW_BYTES;
    this.z.avail_out = PIECE_BYTES;
  }

  /** The stored offset inflate has read to. */
  get at(): number {
    return this.base + this.z.next_in;
  }

  /** True once every byte fed has been read. */
  get hungry(): boolean {
    return this.z.avail_in === 0;
  }

  /** Hands over the next stored bytes, once the last have been read. */
  feed(stored: Uint8Array): void {
    this.base = this.at;
    this.z.input = stored;
    this.z.next_in = 0;
    this.z.avail_in = stored.length;
  }

  /** Inflates a step. The piece it returns is good until the next step. */
  step(): Uint8Array {
    const z = this.z;
    if (this.ended) {
      while (z.avail_in > 0 && z.input[z.next_in] === 0) {
        z.next_in++;
        z.avail_in--;
      }
      if (z.avail_in === 0) return NONE;
      zlibInflateReset(z);
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
    if (!this.ended) throw new BrokenStream(this.at, 'it ends mid-member');
  }
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
 * last checkpoint.
 */
export function gzipInflater(
  budget: InflaterBudget,
  span: number = CHECKPOINT_SPAN,
): Inflater {
  return new GzipInflater(budget, span);
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

  /** The decoded bytes between checkpoints, which thinning doubles. */
  private span: number;

  constructor(budget: InflaterBudget, span: number) {
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
