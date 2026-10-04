/**
 * @fileoverview RecordScanner as a LabScanner: the reference every variant is
 * checked and timed against. Its state is private, and TypeScript allows
 * reading a private member by its quoted name.
 */

import { RecordScanner } from '@ingest/scan';
import type { Begin, LabScanner, State } from './common.ts';

/** BaselineScanner forwards to RecordScanner and reads its state back. */
export class BaselineScanner implements LabScanner {
  private readonly inner: RecordScanner;

  constructor(comma: string, begin: Begin) {
    this.inner = new RecordScanner(comma, begin);
  }

  push(chunk: Uint8Array, base: number): void {
    this.inner.push(chunk, base);
  }

  get state(): State {
    return this.inner['state'];
  }

  get crAt(): number {
    return this.inner['crAt'];
  }
}
