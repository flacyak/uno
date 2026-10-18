/**
 * @fileoverview Shared helpers for the .uno format tests: a workspace to
 * write, and the uno.json it was written with, read back as text or as data,
 * or changed and zipped up again.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { MANIFEST_ENTRY, newManifest, writeDocument } from '@document';
import type { Document, Held } from '@document';

/** Fixed created time, so the full manifest text can be compared. */
export const CREATED = new Date('2026-09-30T12:00:00Z');

/** Where the workspace is saved. */
export const AT = '/home/cpa/q4/books.uno';

/** workspace is a document of `sources` saved to `at`, with one edit logged
 * to the first. */
export function workspace(sources: Held[], at = AT): Document {
  return {
    manifest: { ...newManifest(), created: CREATED },
    sources,
    active: sources[0]!.id,
    log: [
      {
        source: sources[0]!.id,
        edit: { seq: 1, op: 'set', row: 3, col: 1, was: 'West', now: 'west' },
      },
    ],
    extra: new Map(),
    at,
  };
}

/** The written uno.json as text. */
export function manifestText(uno: Uint8Array): string {
  return strFromU8(unzipSync(uno)[MANIFEST_ENTRY]!);
}

/** The written uno.json, as far as the tests read it. */
export interface WrittenManifest {
  format: number;
  modified: string;
  sources: Array<Record<string, unknown>>;
}

/** manifestOf reads the written uno.json. */
export function manifestOf(uno: Uint8Array): WrittenManifest {
  return JSON.parse(manifestText(uno)) as WrittenManifest;
}

/** Writes `doc`, applies `change` to its manifest, and returns the new .uno
 * bytes. */
export function tampered(
  doc: Document,
  change: (m: WrittenManifest) => void,
): Uint8Array {
  const entries = unzipSync(writeDocument(doc));
  const m = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as WrittenManifest;
  change(m);
  entries[MANIFEST_ENTRY] = strToU8(JSON.stringify(m));
  return zipSync(entries);
}

/** The parts of the first source of a written manifest. */
export function partsOf(m: WrittenManifest): Array<Record<string, unknown>> {
  return m.sources[0]!['parts'] as Array<Record<string, unknown>>;
}
