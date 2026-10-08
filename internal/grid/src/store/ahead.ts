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

/**
 * How many recent reads are remembered, to spot a reader going on from one
 * and to know which readers are still about. A reader none of the last few
 * reads belonged to has gone, and what was asked for ahead of it is let go.
 */
export const REMEMBERED = 4;

/** One reader going through the object in order: where it is up to, and how
 * much it reads at a time. */
interface Stream {
  next: number;
  length: number;
}

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
 * Two readers in order share the window rather than take it from each other.
 * The grid drawing two blocks in a row is a reader in order for exactly two
 * reads, and the index pass goes on from where it was a moment later; letting
 * go of what was asked ahead for it would ask for all of it again, every time
 * the page scrolled. So a chunk is held for the reader it was asked for until
 * that reader has not read for `REMEMBERED` reads, and only then let go.
 *
 * A chunk asked for ahead that fails is not an error until somebody reads it:
 * the failure is handed to that read, in the words `read` failed with.
 */
export function readAhead(read: ReadRange, size: number, ahead = AHEAD): ReadRange {
  /** The chunks asked for ahead, by where they start, and for whom. */
  const held = new Map<number, { length: number; bytes: Promise<Uint8Array>; for: Stream }>();
  /** The reader each recent read belonged to, newest last. */
  const recent: Stream[] = [];
  /** The reader in order whose next chunks are asked for. */
  let stream: Stream | undefined;

  function remember(who: Stream): void {
    recent.push(who);
    if (recent.length > REMEMBERED) recent.shift();
  }

  /**
   * topUp asks for the stream's next chunks. The chunk the reader is waiting
   * on counts as one of `ahead`, so no more than `ahead` are ever in flight
   * or held at once -- which is why what was held for a reader that has gone
   * is let go first: it is taking a place in the window from the one here.
   */
  function topUp(): void {
    if (stream === undefined) return;
    for (const [offset, chunk] of held) {
      if (!recent.includes(chunk.for)) held.delete(offset);
    }
    // A reader that has gone is not read ahead of either: its chunks were just
    // let go, and asked for again they would be let go again at every read
    // from somewhere else, bought for nobody.
    if (!recent.includes(stream)) {
      stream = undefined;
      return;
    }
    let at = stream.next;
    while (held.has(at)) at += held.get(at)!.length;
    while (held.size < ahead - 1 && at < size) {
      const length = Math.min(stream.length, size - at);
      const bytes = read(at, length);
      // Handed to whoever reads it; unread, it is nobody's to report.
      bytes.catch(() => undefined);
      held.set(at, { length, bytes, for: stream });
      at += length;
    }
  }

  return (offset, length) => {
    // A reader going on from where it stopped is the one that stopped there,
    // whether or not it is the one being read ahead of: it is now.
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
