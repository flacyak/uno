// Read-ahead for a reader going through an object in order.
//
// Wraps a function that reads one range. When a read continues where an
// earlier one ended, the next chunks of the same length are requested before
// they are asked for, so several requests are in flight at once.

/** How many chunks a sequential reader has in flight or held at once, the
 * one it is waiting on included. */
export const AHEAD = 4;

/** Reads `length` bytes from `offset`. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * How many recent reads are remembered. A read that continues one of them is
 * the same reader. A reader none of them belong to is gone, and the chunks
 * held for it are dropped.
 */
export const REMEMBERED = 4;

/** One sequential reader: the offset its next read starts at, and the
 * length it reads. */
interface Stream {
  next: number;
  length: number;
}

/**
 * readAhead wraps `read` with read-ahead for sequential readers.
 *
 * A read that starts where an earlier read ended continues that reader. The
 * reader's next chunks, of the same length, are requested so that `ahead`
 * are in flight or held, counting the one it is waiting on. Any other read
 * is passed to `read` as it is.
 *
 * A held chunk stays with the reader it was requested for while that reader
 * is among the last `REMEMBERED` reads. Then it is dropped. Two sequential
 * readers share the window.
 *
 * A held chunk whose request failed throws from the read that takes it, with
 * the error `read` threw.
 */
export function readAhead(read: ReadRange, size: number, ahead = AHEAD): ReadRange {
  /** Held chunks by start offset, with the reader each was requested for. */
  const held = new Map<number, { length: number; bytes: Promise<Uint8Array>; for: Stream }>();
  /** The reader of each recent read, newest last. */
  const recent: Stream[] = [];
  /** The sequential reader whose next chunks are requested. */
  let stream: Stream | undefined;

  function remember(who: Stream): void {
    recent.push(who);
    if (recent.length > REMEMBERED) recent.shift();
  }

  /**
   * topUp requests the stream's next chunks. Chunks held for readers that
   * left `recent` are dropped first. The chunk the caller is waiting on
   * counts as one of `ahead`, so at most `ahead - 1` are held.
   */
  function topUp(): void {
    if (stream === undefined) return;
    for (const [offset, chunk] of held) {
      if (!recent.includes(chunk.for)) held.delete(offset);
    }
    // A stream none of the recent reads belong to is gone.
    if (!recent.includes(stream)) {
      stream = undefined;
      return;
    }
    let at = stream.next;
    while (held.has(at)) at += held.get(at)!.length;
    while (held.size < ahead - 1 && at < size) {
      const length = Math.min(stream.length, size - at);
      const bytes = read(at, length);
      // The read that takes the chunk reports the error, if any.
      bytes.catch(() => undefined);
      held.set(at, { length, bytes, for: stream });
      at += length;
    }
  }

  return (offset, length) => {
    // A read that starts where a recent read ended continues that reader,
    // which becomes the stream.
    const going = recent.findLast((who) => who.next === offset);
    if (going === undefined) {
      remember({ next: offset + length, length });
    } else {
      going.next = offset + length;
      going.length = length;
      stream = going;
      remember(going);
    }

    const got = held.get(offset);
    const bytes = got !== undefined && got.length === length ? got.bytes : read(offset, length);
    if (got?.bytes === bytes) held.delete(offset);
    topUp();
    return bytes;
  };
}
