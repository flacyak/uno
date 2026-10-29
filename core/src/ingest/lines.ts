/**
 * @fileoverview Finds where JSON Lines records start, working on raw bytes,
 * and splits decoded text into the same records.
 *
 * A record is a line that holds a non-blank byte, where space, tab and CR
 * count as blank. JSON forbids a raw LF inside a string, so every LF ends a
 * line, and the scanner carries no quote state and can start at any line.
 * The bytes it reacts to are all ASCII, so every byte of a multi-byte UTF-8
 * character is data. tests/ingest/lines.test.ts checks the scanner against
 * splitLines over random input.
 */

import type { Scanner } from './format.ts';

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;

/** isBlank says whether a byte or a character code is a space, a tab or a CR. */
function isBlank(code: number): boolean {
  return code === SPACE || code === TAB || code === CR;
}

/**
 * LineScanner is fed a file's bytes in order, in chunks of any size, and
 * calls `begin` with the offset of the first byte of every line that holds a
 * non-blank byte. The first byte pushed starts a line. A record is reported
 * as soon as its first non-blank byte is pushed, so pushing the last chunk
 * finishes the scan.
 */
export class LineScanner implements Scanner {
  /** Where the line being scanned starts. Unset until the first push. */
  private lineAt: number | undefined;
  /** Whether the line being scanned is a record, already reported. */
  private inRecord = false;
  private readonly begin: (offset: number) => void;

  constructor(begin: (offset: number) => void) {
    this.begin = begin;
  }

  /**
   * push scans `chunk`, whose first byte sits at offset `base` in the file.
   * Past a record's first non-blank byte only its LF matters, so it searches
   * for that.
   */
  push(chunk: Uint8Array, base: number): void {
    const end = chunk.length;
    let lineAt = this.lineAt ?? base;
    let inRecord = this.inRecord;
    let i = 0;

    while (i < end) {
      if (inRecord) {
        const lf = chunk.indexOf(LF, i);
        if (lf < 0) break;
        inRecord = false;
        i = lf + 1;
        lineAt = base + i;
        continue;
      }
      const b = chunk[i]!;
      if (b === LF) {
        lineAt = base + i + 1;
      } else if (!isBlank(b)) {
        this.begin(lineAt);
        inRecord = true;
      }
      i++;
    }

    this.lineAt = lineAt;
    this.inRecord = inRecord;
  }
}

/**
 * splitLines returns the records in `text` by LineScanner's rule: every line
 * that holds a character other than a space, a tab or a CR. Each comes
 * without its LF, and without a CR at its end.
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  for (let start = 0; start < text.length;) {
    const lf = text.indexOf('\n', start);
    const end = lf < 0 ? text.length : lf;
    if (holdsNonBlank(text, start, end)) {
      const last = text.charCodeAt(end - 1) === CR ? end - 1 : end;
      lines.push(text.slice(start, last));
    }
    start = end + 1;
  }
  return lines;
}

/**
 * holdsNonBlank says whether `text` from `start` up to `end` holds a
 * non-blank character.
 */
function holdsNonBlank(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (!isBlank(text.charCodeAt(i))) return true;
  }
  return false;
}
