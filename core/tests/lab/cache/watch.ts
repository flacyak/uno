/**
 * @fileoverview A provider wrapper that counts the reads made through it and
 * can add a delay before each one.
 *
 * The delay works as the harness's `slowed` does, a sleep before every read,
 * but it can be switched on after the index is built. That lets the lab time a
 * person's session over a bucket-like source without paying 50 ms for every
 * 8 MB chunk of a 1 GB index.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import type { Provider } from '@plugin';
import type { ByteSource } from '@store';

/** Watch counts reads and holds the delay added before each. */
export class Watch {
  /** Reads made through the provider's sources. */
  reads = 0;
  /** Bytes those reads returned. */
  bytes = 0;
  /** Milliseconds slept before each read. 0 adds no delay. */
  delayMs = 0;

  readonly provider: Provider;

  constructor(inner: Provider) {
    const { files } = inner;
    this.provider = {
      ...inner,
      files: {
        label: files.label,
        handles: (ref) => files.handles(ref),
        open: async (ref) => this.watched(await files.open(ref)),
      },
    };
  }

  /** watched wraps one source so its reads are counted and delayed. */
  private watched(source: ByteSource): ByteSource {
    return {
      size: source.size,
      version: source.version,
      read: async (offset, length) => {
        if (this.delayMs > 0) await sleep(this.delayMs);
        const got = await source.read(offset, length);
        this.reads++;
        this.bytes += got.length;
        return got;
      },
      close: () => source.close(),
    };
  }
}
