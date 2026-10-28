/**
 * @fileoverview Reads a JSON Lines file as records: a row for each line that
 * holds a non-blank byte, and a column for each key, in the order the keys
 * are first seen.
 *
 * The index pass walks every line into a KeyRegistry, so every key in a
 * block has its column before the block can be read. A decode puts each
 * cell in its key's column and adds no column. A line that does not lay out
 * in full, because it is not one JSON object or holds a key past the column
 * limit, keeps its whole text in the line column beside the cells it could
 * place, so every line the scanner finds is a row.
 */

import { concat } from '@go';
import { decodersFor } from './format.ts';
import type { Scanner } from './format.ts';
import { walkLine } from './json.ts';
import { JSON_COLUMNS_LIMIT, KeyRegistry, LINE_KEY } from './keys.ts';
import type { KeyedColumn } from './keys.ts';
import { LineScanner, splitLines } from './lines.ts';
import type { RecordFormat } from './records.ts';
import { bomLength } from './scan.ts';
import { sniffEncoding } from './sniff.ts';

/** The byte that ends a line. */
const LF = 0x0a;

/**
 * learn places the keys of one line in `registry`, and the line column when
 * the line does not lay out in full.
 */
function learn(registry: KeyRegistry, line: string): void {
  let placed = true;
  const object = walkLine(line, (key) => {
    if (registry.place(key) === undefined) placed = false;
  });
  if (!object || !placed) registry.line();
}

/**
 * KeyIndexer is the index pass's scanner for JSON Lines. It reports where
 * each record starts as LineScanner does, and walks every line into a
 * KeyRegistry before it reports the record after it. The last line, which
 * may have no LF, is walked at end.
 */
class KeyIndexer implements Scanner {
  private readonly lines: LineScanner;
  /** The bytes pushed of the line no LF has ended yet. */
  private open: Uint8Array[] = [];

  private readonly registry: KeyRegistry;
  private readonly decoder: TextDecoder;

  constructor(
    registry: KeyRegistry,
    decoder: TextDecoder,
    begin: (offset: number) => void,
  ) {
    this.registry = registry;
    this.decoder = decoder;
    this.lines = new LineScanner(begin);
  }

  push(chunk: Uint8Array, base: number): void {
    const ended = chunk.lastIndexOf(LF) + 1;
    if (ended === 0) {
      this.open.push(chunk.slice());
    } else {
      const closed = chunk.subarray(0, ended);
      this.learn(
        this.open.length === 0 ? closed : concat([...this.open, closed]),
      );
      this.open = ended === chunk.length ? [] : [chunk.slice(ended)];
    }
    this.lines.push(chunk, base);
  }

  end(): void {
    this.learn(concat(this.open));
    this.open = [];
  }

  /** learn walks every line in `bytes`, which end where a line does. */
  private learn(bytes: Uint8Array): void {
    for (const line of splitLines(this.decoder.decode(bytes))) {
      learn(this.registry, line);
    }
  }
}

/**
 * rowOf lays one line out over the columns `registry` has: each cell in its
 * key's column, and the whole line in the line column when the line does not
 * lay out in full. It adds no column.
 */
function rowOf(registry: KeyRegistry, line: string): string[] {
  const row = Array.from({ length: registry.columns().length }, () => '');
  let placed = true;
  const object = walkLine(line, (key, text) => {
    const at = registry.columnOf(key);
    if (at === undefined) placed = false;
    else row[at] = text;
  });
  const whole = object && placed ? undefined : registry.columnOf(LINE_KEY);
  if (whole !== undefined) row[whole] = line;
  return row;
}

/**
 * linesFormat reads a JSON Lines file named `name` whose head is `head`. Its
 * columns start as `pinned`, and its indexer adds one for each new key while
 * keys hold fewer than JSON_COLUMNS_LIMIT, and the line column the first
 * time a line does not lay out in full. A UTF-16 head is refused by name, as
 * delimited text's is.
 */
export function linesFormat(
  name: string,
  head: Uint8Array,
  pinned: readonly KeyedColumn[],
): RecordFormat {
  const { data, charset } = decodersFor(name, sniffEncoding(head));
  const registry = new KeyRegistry(pinned, JSON_COLUMNS_LIMIT);
  return {
    dataStart: bomLength(head),
    columns: () => registry.columns(),
    scanner: (begin) => new LineScanner(begin),
    indexer: (begin) => new KeyIndexer(registry, data, begin),
    decode: (bytes) =>
      splitLines(data.decode(bytes)).map((line) => rowOf(registry, line)),
    label: () => ({ t: 'read-lines', charset }),
  };
}
