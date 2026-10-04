// Setup file, listed in vite.config.ts, that runs around every test file.
// It wraps `open` from node:fs/promises to track every FileHandle opened
// during the test file, and fails the file if any handle is still open at
// the end. The failure message includes the stack from where each leaked
// handle was opened.

import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll } from "vite-plus/test";

/**
 * How long to wait for late closes after the last test. An engine closes its
 * files a moment after the test that sent the close message ends.
 */
const SETTLE_MS = 5000;

/** Poll interval for the wait. */
const LOOK_MS = 5;

const open = fs.promises.open;

/** Every handle still open, with the stack of where it was opened. */
const unclosed = new Map<FileHandle, string>();

const watched: typeof open = async (...args) => {
  // Captured before the await so the caller is still on the stack.
  const where = new Error(`${String(args[0])} was opened and never closed`).stack ?? "";
  const handle = await open(...args);
  unclosed.set(handle, where);
  // Every way of closing a handle (direct call, stream, `await using`) goes
  // through `close`.
  const close = handle.close.bind(handle);
  handle.close = () => {
    unclosed.delete(handle);
    return close();
  };
  return handle;
};

/** Replaces `fs.promises.open` with `fn` for both CJS and ESM importers. */
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
  // Close the leaked handles here so each leak is reported once, under the
  // test file that opened it, before the garbage collector finds it.
  await Promise.all(left.map(([handle]) => handle.close()));
  if (left.length > 0) {
    throw new Error(
      `${left.length} of the files this test file opened were left open\n\n${left.map(([, where]) => where).join("\n\n")}`,
    );
  }
});
