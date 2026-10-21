/**
 * @fileoverview Inflates gzip, every member of a file in turn.
 *
 * It runs pako's low-level zlib API through one class, Members, which
 * inflates gzip members one after another and stops at every deflate block
 * boundary.
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

/** How far back a deflate reference reaches: the bytes a window holds. */
export const WINDOW_BYTES = 32 << 10;

/** zlib's window bits for a 32 KB window. */
const MAX_WINDOW_BITS = 15;
/** Added to the window bits, it has zlib read a gzip wrapper and only that. */
const GZIP_WRAPPER = 16;
/** Window bits that have zlib read a gzip wrapper. */
const GZIP_WINDOW_BITS = MAX_WINDOW_BITS + GZIP_WRAPPER;
/** Decoded bytes inflated past the window before the buffer slides. */
const PIECE_BYTES = 256 << 10;
/** The piece of a step that read padding alone. */
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
