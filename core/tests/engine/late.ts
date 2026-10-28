/**
 * @fileoverview A JSON Lines file whose key is first seen at row 50,000, the
 * workspace that says it was read as JSON Lines, alone or as the one part of
 * a source with a _file column, and an engine whose disk holds every read
 * past a byte until it is let through, so a test can stop the file's index
 * short of the key or just past it.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newManifest, writeDocument } from '@document';
import type { Held } from '@document';
import type { ColumnInfo, Engine, SourceHandle } from '@engine';
import type { Provider } from '@plugin';
import { diskProvider } from '@store/node';
import {
  TINY,
  connect,
  multiProviders,
  openOne,
  readsThrough,
} from './harness.ts';

/** The row the late key is first seen at. */
export const LATE = 50_000;
/** Rows from LATE on, each with the late key: more than a held index stops short of. */
const TAIL = 1_000;
/** The key first seen at LATE. */
export const LATE_KEY = 'late';
/** The id key every line has. */
export const ID_KEY = 'id';
/** The file's name, and what _file shows for each of its rows. */
export const NAME = 'events.jsonl';
/** The source's id in the workspace. */
export const SOURCE = 'events';
/** The one byte a part's open reads at its end, which is never held. */
const MEASURED = 1;
/**
 * Bytes past the start of row LATE where a held index stops: two TINY
 * chunks, so the line is read whole and its block is readable.
 */
export const PAST_LATE = 2 * TINY.chunkBytes;

/** cellsAt returns row `row`'s id and late cells, as the file holds them. */
export function cellsAt(row: number): string[] {
  return [String(row), row >= LATE ? `l${row}` : ''];
}

/** OnDisk is the file on disk, and the byte its row LATE starts at. */
export interface OnDisk {
  readonly path: string;
  readonly bytes: number;
  readonly late: number;
}

/** asText returns `lines`, each ended by an LF. */
function asText(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}

/** written writes the file: an id on each line, and from LATE a late key. */
export async function written(): Promise<OnDisk> {
  const lines: string[] = [];
  for (let row = 0; row < LATE + TAIL; row++) {
    const [id, late] = cellsAt(row);
    lines.push(
      row < LATE
        ? `{"${ID_KEY}":${id}}`
        : `{"${ID_KEY}":${id},"${LATE_KEY}":"${late}"}`,
    );
  }
  const text = asText(lines);
  const path = join(await mkdtemp(join(tmpdir(), 'uno-widen-')), NAME);
  await writeFile(path, text);
  return {
    path,
    bytes: Buffer.byteLength(text),
    late: Buffer.byteLength(asText(lines.slice(0, LATE))),
  };
}

/**
 * Layout is how a workspace holds the file: alone, or as the one part of a
 * source that shows each row's file in _file.
 */
export type Layout = 'file' | 'part';

/** workspace returns a .uno that says the file was read as JSON Lines. */
export function workspace(file: OnDisk, layout: Layout): Blob {
  const base = {
    id: SOURCE,
    kind: 'jsonl',
    rows: 0,
    cols: 0,
    state: { active: { row: 0, col: 0 } },
  } as const;
  const held: Held =
    layout === 'file'
      ? { ...base, name: NAME, path: file.path, bytes: file.bytes }
      : {
          ...base,
          name: SOURCE,
          parts: [
            {
              name: NAME,
              path: file.path,
              bytes: file.bytes,
              skip: 0,
              unterminated: false,
            },
          ],
          header: 'first',
          fileColumn: true,
        };
  const uno = writeDocument({
    manifest: newManifest(),
    sources: [held],
    active: SOURCE,
    log: [],
    extra: new Map(),
    at: '',
  });
  return new Blob([new Uint8Array(uno)]);
}

/** HeldDisk is a disk provider whose reads past a byte wait to be let through. */
interface HeldDisk {
  readonly provider: Provider;
  /** Resolves once a read is held. */
  readonly reached: Promise<void>;
  /** Lets every held read through, and every read after it. */
  readonly release: () => void;
}

/** heldPast returns the disk provider with every read of the file that ends past `from` held. */
function heldPast(from: number): HeldDisk {
  let reach = (): void => {};
  let release = (): void => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = readsThrough(diskProvider(), async (ref, offset, length) => {
    if (ref.name === NAME && length > MEASURED && offset + length > from) {
      reach();
      await gate;
    }
  });
  return { provider, reached, release };
}

/** Open is a source over the file whose index is held. */
export interface Open {
  readonly engine: Engine;
  readonly src: SourceHandle;
  /** Lets the index on to the end. */
  readonly release: () => void;
  /** The columns the source has been told at each generation since it opened. */
  readonly told: ReadonlyMap<number, ColumnInfo[]>;
}

/**
 * toldAt returns the columns `src` is told at each generation, from its
 * open on.
 */
function toldAt(src: SourceHandle): Map<number, ColumnInfo[]> {
  const told = new Map([[src.opened.generation, src.opened.columns]]);
  src.onColumns = (columns, generation) => told.set(generation, columns);
  return told;
}

/**
 * withHeld opens the workspace `blob` under TINY tuning, with every read of
 * the file that ends past byte `from` held, and runs `use` once the index
 * waits there. The engine is closed after.
 */
export async function withHeld<T>(
  blob: Blob,
  from: number,
  use: (open: Open) => Promise<T>,
): Promise<T> {
  const disk = heldPast(from);
  const { engine, done } = connect(TINY, multiProviders(disk.provider));
  try {
    const src = await openOne(engine, { name: 'q3.uno', blob });
    const told = toldAt(src);
    await disk.reached;
    return await use({ engine, src, release: disk.release, told });
  } finally {
    disk.release();
    done();
  }
}
