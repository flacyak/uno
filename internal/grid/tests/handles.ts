// Every file a test file opens is closed by the time that test file is done.
//
// A FileHandle nobody closes is closed by the garbage collector, whenever it
// gets to it. Node prints DEP0137 when that happens and says it will be an
// error one day, so a leak shows up as a warning in some runs and not in
// others, under whichever test happened to be running at the time. This says
// it every run, against the test file that did it, with where the file was
// opened.
//
// It is a setup file: vite.config.ts lists it, so it runs around every test
// file. It watches `open` from node:fs/promises, which is the one way a
// FileHandle is made, and so the only way `store/node` opens a file.

import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll } from "vite-plus/test";

/**
 * How long a test file's last closes are given to land. An engine is closed
 * by a message, so the files it holds are closed a moment after the test that
 * asked is over.
 */
const SETTLE_MS = 5000;

/** How often the wait looks again. */
const LOOK_MS = 5;

const open = fs.promises.open;

/** Every handle opened and not yet closed, and where it was opened. */
const unclosed = new Map<FileHandle, string>();

const watched: typeof open = async (...args) => {
  // Taken before the open, while the caller is still on the stack.
  const where = new Error(`${String(args[0])} was opened and never closed`).stack ?? "";
  const handle = await open(...args);
  unclosed.set(handle, where);
  // Whatever closes a handle calls its `close`: a caller, a stream, `await using`.
  const close = handle.close.bind(handle);
  handle.close = () => {
    unclosed.delete(handle);
    return close();
  };
  return handle;
};

/** watch puts `fn` where `open` is, for every module that imports it by either name. */
function watch(fn: typeof open): void {
  Object.defineProperty(fs.promises, "open", { value: fn, writable: true, configurable: true });
  syncBuiltinESMExports();
}

beforeAll(() => watch(watched));

afterAll(async () => {
  for (let waited = 0; unclosed.size > 0 && waited < SETTLE_MS; waited += LOOK_MS) {
    await sleep(LOOK_MS);
  }
  watch(open);

  const left = [...unclosed];
  unclosed.clear();
  // Closed here, so the leak is reported once and by name, and not a second
  // time by the garbage collector under another test.
  await Promise.all(left.map(([handle]) => handle.close()));
  if (left.length > 0) {
    throw new Error(
      `${left.length} of the files this test file opened were left open\n\n${left.map(([, where]) => where).join("\n\n")}`,
    );
  }
});
