// Read-ahead: the next ranges of an object asked for before anybody reads them.
//
// Indexing reads a file from front to back, one chunk at a time, and waits for
// each before asking for the next. On a disk that costs nothing. Against a
// bucket every chunk is a round trip, so a 30 GB object is some 3,800 of them
// in a row, and most of the time goes to waiting. Asking for the next few while
// the first is on its way turns that into a few trips' worth of waiting.
//
// It is pure: it wraps a function that reads a range, and knows nothing about
// where the range comes from.

/** How many chunks a reader going through an object in order has asked for ahead
 * of it, in flight or waiting to be read. It is also all read-ahead ever holds:
 * four of the 8 MB chunks indexing reads is 32 MB. */
export const AHEAD = 4;

/** A read of one range. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/** How many recent read ends are remembered to spot a reader going on from one. */
const REMEMBERED = 4;

/**
 * readAhead wraps `read` with read-ahead for a reader going through the object
 * in order.
 *
 * A read that starts where an earlier one ended is taken as that reader going
 * on, and the next chunks of the same length are asked for behind it, so that
 * with the one it is waiting on `ahead` are in flight or waiting. Any other
 * read -- the grid fetching the rows on screen, a search jumping to a row -- is
 * read as asked and changes nothing, so a reader in order keeps its chunks
 * coming while the page reads around it.
 *
 * A chunk asked for ahead that fails is not an error until somebody reads it:
 * the failure is handed to that read, in the words `read` failed with.
 */
export function readAhead(read: ReadRange, size: number, ahead = AHEAD): ReadRange {
  /** The chunks asked for ahead, by where they start. */
  const held = new Map<number, { length: number; bytes: Promise<Uint8Array> }>();
  /** Where recent reads ended, newest last. */
  const ends: number[] = [];
  /** Where the reader in order is up to, and how much it reads at a time. */
  let stream: { next: number; length: number } | undefined;

  function ended(at: number): void {
    ends.push(at);
    if (ends.length > REMEMBERED) ends.shift();
  }

  /**
   * topUp asks for the stream's next chunks. The chunk the reader is waiting
   * on counts as one of `ahead`, so no more than `ahead` are ever in flight
   * or held at once.
   */
  function topUp(): void {
    if (stream === undefined) return;
    let at = stream.next;
    while (held.has(at)) at += held.get(at)!.length;
    while (held.size < ahead - 1 && at < size) {
      const length = Math.min(stream.length, size - at);
      const bytes = read(at, length);
      // Handed to whoever reads it; unread, it is nobody's to report.
      bytes.catch(() => undefined);
      held.set(at, { length, bytes });
      at += length;
    }
  }

  return (offset, length) => {
    const got = held.get(offset);
    if (got !== undefined && got.length === length) {
      held.delete(offset);
      stream = { next: offset + length, length };
      ended(offset + length);
      topUp();
      return got.bytes;
    }

    // A reader going on from where it stopped, and somewhere other than the
    // stream already being read ahead of: that stream has moved on, so what
    // was asked for it is let go rather than held against the new one.
    if (ends.includes(offset) && offset !== stream?.next) {
      held.clear();
      stream = { next: offset + length, length };
    } else if (offset === stream?.next) {
      stream = { next: offset + length, length };
    }
    ended(offset + length);
    const bytes = read(offset, length);
    topUp();
    return bytes;
  };
}
