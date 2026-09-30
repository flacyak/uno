// The row index, and the page cache that reads rows through it.
//
// The index is two arrays of numbers with one entry per block of rows. The
// page cache keeps decoded blocks up to a byte budget.

import type { Format } from "../ingest/index.ts";
import { Refusal } from "../said/index.ts";
import type { ByteSource } from "../store/index.ts";

export interface Tuning {
  /** Bytes a pass reads at a time. */
  chunkBytes: number;
  /** The most rows in a block. */
  blockRows: number;
  /**
   * The bytes a block reaches before the next row starts a new one. A single
   * row larger than this is a block on its own.
   */
  blockBytes: number;
  /** Bytes of source the page cache keeps decoded. */
  cacheBytes: number;
}

export const TUNING: Tuning = {
  chunkBytes: 8 << 20,
  blockRows: 1024,
  blockBytes: 1 << 20,
  cacheBytes: 32 << 20,
};

/**
 * RowIndex records where each block of rows starts in the file, as a row
 * number and a byte offset.
 *
 * A block is a run of whole records, so any block can be read and decoded on
 * its own. A row's block is found by binary search over the block starts.
 */
export class RowIndex {
  private firsts = new Float64Array(64);
  private offsets = new Float64Array(64);
  private blocks = 0;

  /** Records the scan has passed so far. */
  counted = 0;
  /** Byte offset the scan has read to. */
  scanned: number;
  complete = false;

  constructor(
    /** Where the first data record starts. */
    readonly start: number,
    readonly size: number,
    private readonly tuning: Pick<Tuning, "blockRows" | "blockBytes">,
  ) {
    this.scanned = start;
  }

  /** begin records that the next record starts at offset. Called once per record, in order. */
  begin(offset: number): void {
    const b = this.blocks;
    if (
      b === 0 ||
      this.counted - this.firsts[b - 1]! >= this.tuning.blockRows ||
      offset - this.offsets[b - 1]! >= this.tuning.blockBytes
    ) {
      if (b === this.firsts.length) {
        this.firsts = grow(this.firsts);
        this.offsets = grow(this.offsets);
      }
      this.firsts[b] = this.counted;
      this.offsets[b] = offset;
      this.blocks = b + 1;
    }
    this.counted++;
  }

  /**
   * readable returns how many rows can be read now. Before the scan finishes
   * this excludes the last block, which may still be growing.
   */
  readable(): number {
    if (this.complete) return this.counted;
    return this.blocks === 0 ? 0 : this.firsts[this.blocks - 1]!;
  }

  /** rows returns the row count once complete, or an estimate from the bytes scanned so far. */
  rows(): number {
    if (this.complete) return this.counted;
    const read = this.scanned - this.start;
    if (read <= 0 || this.counted === 0) return this.counted;
    return Math.max(this.counted, Math.round((this.counted / read) * (this.size - this.start)));
  }

  /** Returns the block holding a readable row. */
  blockOf(row: number): number {
    let lo = 0;
    let hi = this.blocks - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.firsts[mid]! <= row) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Returns the row range of a block, as [first, end). */
  rowsOf(block: number): [number, number] {
    const end = block + 1 < this.blocks ? this.firsts[block + 1]! : this.counted;
    return [this.firsts[block]!, end];
  }

  /** Returns the byte range of a block, as [start, end). */
  bytesOf(block: number): [number, number] {
    const end = block + 1 < this.blocks ? this.offsets[block + 1]! : this.size;
    return [this.offsets[block]!, end];
  }
}

function grow(a: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
  const b = new Float64Array(a.length * 2);
  b.set(a);
  return b;
}

/**
 * Pages reads rows through an index and caches decoded blocks.
 *
 * The cache is bounded by the source bytes of the blocks it holds. The least
 * recently used block is evicted first.
 */
export class Pages {
  private readonly cache = new Map<number, { records: string[][]; bytes: number }>();
  private readonly loading = new Map<number, Promise<string[][]>>();
  private kept = 0;

  constructor(
    private readonly name: string,
    private readonly source: ByteSource,
    private readonly format: Format,
    private readonly index: RowIndex,
    private readonly budget: number,
  ) {}

  /** Source bytes of the blocks in the cache. */
  get held(): number {
    return this.kept;
  }

  /** rows reads up to count rows from first, stopping at the readable limit. */
  async rows(first: number, count: number): Promise<string[][]> {
    const end = Math.min(first + count, this.index.readable());
    const out: string[][] = [];

    for (let row = Math.max(0, first); row < end;) {
      const block = this.index.blockOf(row);
      const [from] = this.index.rowsOf(block);
      const records = await this.records(block);
      for (let i = row - from; i < records.length && row < end; i++, row++) out.push(records[i]!);
    }
    return out;
  }

  /**
   * records reads one block's source rows. With `keep = false` the block is
   * decoded and the cache is left as it is.
   */
  records(block: number, keep = true): Promise<string[][]> {
    const hit = this.cache.get(block);
    if (hit !== undefined) {
      // Re-insert so the block becomes the newest entry in the Map.
      this.cache.delete(block);
      this.cache.set(block, hit);
      return Promise.resolve(hit.records);
    }

    let pending = this.loading.get(block);
    if (pending !== undefined) return pending;
    if (!keep) return this.decode(block);

    pending = this.decode(block)
      .then((records) => {
        this.keep(block, records);
        return records;
      })
      .finally(() => this.loading.delete(block));
    this.loading.set(block, pending);
    return pending;
  }

  private async decode(block: number): Promise<string[][]> {
    const [start, end] = this.index.bytesOf(block);
    const [from, to] = this.index.rowsOf(block);
    const records = this.format.decode(await this.source.read(start, end - start));

    // A block with a different row count than the index recorded means the
    // file was rewritten while open.
    if (records.length !== to - from) {
      throw new Refusal({ t: "changed-on-disk", name: this.name });
    }
    return records;
  }

  private keep(block: number, records: string[][]): void {
    const [start, end] = this.index.bytesOf(block);
    this.cache.set(block, { records, bytes: end - start });
    this.kept += end - start;
    for (const [key, entry] of this.cache) {
      if (this.kept <= this.budget || key === block) break;
      this.cache.delete(key);
      this.kept -= entry.bytes;
    }
  }
}
