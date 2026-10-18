/**
 * @fileoverview listWith and walkWith pick the first lister that claims a path,
 * and refuse by name a path every lister passes on.
 *
 * The listers here are stubs that record what they were asked. Real listings
 * are in disk.test.ts and s3list.test.ts, and real walks in s3walk.test.ts.
 */

import { expect, test } from 'vite-plus/test';

import type { Entry, Lister, Listing } from '@store';
import { listWith, walkWith } from '@store';

/** A lister that claims paths starting with `prefix` and lists what it was handed. */
function stub(
  label: string,
  prefix: string,
): Lister & { asked: Array<[string, string | undefined]> } {
  const asked: Array<[string, string | undefined]> = [];
  return {
    label,
    asked,
    handles: (path) => path.startsWith(prefix),
    list(path, cursor): Promise<Listing> {
      asked.push([path, cursor]);
      return Promise.resolve({
        entries: [entry(path + 'a.csv')],
        next: cursor ?? 'page-2',
      });
    },
    stat: (path) => Promise.resolve(entry(path)),
  };
}

function entry(path: string): Entry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    folder: false,
    bytes: 7,
  };
}

test('a path is listed by the first lister that claims it', async () => {
  const disk = stub('local files', '/');
  const s3 = stub('S3', 's3://');

  const listing = await listWith([disk, s3], 's3://acme/exports/');

  expect(listing.entries.map((e) => e.path)).toEqual([
    's3://acme/exports/a.csv',
  ]);
  expect(s3.asked).toEqual([['s3://acme/exports/', undefined]]);
  expect(disk.asked, 'the lister that did not claim it is never asked').toEqual(
    [],
  );
});

// The cursor reaches the lister unchanged.
test('the cursor is handed to the lister as it came', async () => {
  const s3 = stub('S3', 's3://');

  const listing = await listWith([s3], 's3://acme/', '1/opaque+token==');

  expect(s3.asked).toEqual([['s3://acme/', '1/opaque+token==']]);
  expect(listing.next).toBe('1/opaque+token==');
});

// The refusal names the path and what this build browses.
test('a path nothing claims is refused by name', async () => {
  const disk = stub('local files', '/');

  await expect(listWith([disk], 's3://acme/exports/')).rejects.toThrow(
    's3://acme/exports/: nothing here browses it · this build browses local files',
  );
});

test('a build with no listers says so rather than trailing off', async () => {
  await expect(listWith([], '/home/jo/')).rejects.toThrow(
    '/home/jo/: nothing here browses it · this build browses nothing',
  );
});

/** A stub that also walks, answering each walk with one file a folder down. */
function walker(label: string, prefix: string): ReturnType<typeof stub> {
  const lister = stub(label, prefix);
  return {
    ...lister,
    walk(root, cursor): Promise<Listing> {
      lister.asked.push([root, cursor]);
      const file = 'year=2025/a.csv';
      return Promise.resolve({
        entries: [{ ...entry(root + file), name: file }],
      });
    },
  };
}

// A lister that cannot walk is passed over for one that can.
test('a walk goes to the first lister that claims the path and walks', async () => {
  const browses = stub('S3', 's3://');
  const walks = walker('S3', 's3://');

  const listing = await walkWith([browses, walks], 's3://acme/', 'k');

  expect(listing.entries.map((e) => e.path)).toEqual([
    's3://acme/year=2025/a.csv',
  ]);
  expect(walks.asked).toEqual([['s3://acme/', 'k']]);
  expect(browses.asked).toEqual([]);
});

test('a walk nothing here can make is refused, naming what walks', async () => {
  const listers = [walker('local files', '/'), stub('S3', 's3://')];

  await expect(walkWith(listers, 's3://acme/')).rejects.toThrow(
    's3://acme/: nothing here lists every file under it · this build lists folders in local files',
  );
});
