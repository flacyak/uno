/**
 * @fileoverview Reads a JSON Lines file as records: a row for each line that
 * holds a non-blank byte, and a column for each key, in the order the keys
 * are first seen.
 *
 * A decode puts each cell in its key's column and adds no column. A line
 * that does not lay out in full, because it is not one JSON object or holds
 * a key with no column, keeps its whole text in the line column beside the
 * cells it could place, so every line the scanner finds is a row.
 */

import { decodersFor } from './format.ts';
import { walkLine } from './json.ts';
import { JSON_COLUMNS_LIMIT, KeyRegistry, LINE_KEY } from './keys.ts';
import type { KeyedColumn } from './keys.ts';
import { LineScanner, splitLines } from './lines.ts';
import type { RecordFormat } from './records.ts';
import { bomLength } from './scan.ts';
import { sniffEncoding } from './sniff.ts';

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
 * linesFormat reads a JSON Lines file named `name` whose head is `head`, over
 * the columns `pinned`. A UTF-16 head is refused by name, as delimited
 * text's is.
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
    indexer: (begin) => new LineScanner(begin),
    decode: (bytes) =>
      splitLines(data.decode(bytes)).map((line) => rowOf(registry, line)),
    label: () => ({ t: 'read-lines', charset }),
  };
}
