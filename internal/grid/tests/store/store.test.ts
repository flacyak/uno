import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import type { Formula } from "../../src/library/index.ts";
import { loadLibrary, saveFormula } from "../../src/store/index.ts";
import { nodeStore } from "../../src/store/node.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "uno-store-"));
}

function column(id: string, name: string, expr: string): Formula {
  return { format: 0, id, name, kind: "column", expr, created: undefined, modified: undefined };
}

test("a saved formula reads back out of the directory", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await saveFormula(store, dir, column("unit-margin", "Unit margin", "(price - cost) / price"));

  const { formulas, failed } = await loadLibrary(store, dir);
  expect(failed).toEqual([]);
  expect(formulas).toHaveLength(1);
  expect(formulas[0]!.id).toBe("unit-margin");
  expect(formulas[0]!.expr).toBe("(price - cost) / price");
});

// Sorted by id, so the caller is handed a stable order instead of whatever the
// directory happened to give.
test("the library comes back in id order", async () => {
  const store = nodeStore();
  const dir = await scratch();

  for (const id of ["zeta", "alpha", "mu"]) {
    await saveFormula(store, dir, column(id, id, "a + b"));
  }

  const { formulas } = await loadLibrary(store, dir);
  expect(formulas.map((f) => f.id)).toEqual(["alpha", "mu", "zeta"]);
});

// One bad file costs one formula and not the library: the drawer still opens
// with the others in it, and the caller still has something specific to say
// about the missing one.
test("one unreadable file costs one formula and not the library", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await saveFormula(store, dir, column("good", "Good", "a + b"));
  await saveFormula(store, dir, column("also-good", "Also good", "c * d"));
  await writeFile(join(dir, "broken.unof"), "{not json");

  const { formulas, failed } = await loadLibrary(store, dir);
  expect(formulas.map((f) => f.id)).toEqual(["also-good", "good"]);
  expect(failed).toHaveLength(1);
  expect(failed[0]!.message, "the failure should name the file").toContain("broken.unof");
});

// A person who has never written a formula has no folder, and that is not a
// fault worth reporting to them.
test("a library that does not exist yet is empty rather than broken", async () => {
  const store = nodeStore();
  const dir = join(await scratch(), "never-created");

  const { formulas, failed } = await loadLibrary(store, dir);
  expect(formulas).toEqual([]);
  expect(failed).toEqual([]);
});

test("files that are not .unof are ignored", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await saveFormula(store, dir, column("real", "Real", "a"));
  await writeFile(join(dir, "notes.txt"), "not a formula");
  await writeFile(join(dir, "README.md"), "# nor this");

  const { formulas } = await loadLibrary(store, dir);
  expect(formulas.map((f) => f.id)).toEqual(["real"]);
});

// The write is the one operation that can destroy something, and the promise is
// that the previously saved file is still there.
test("a write leaves no debris behind", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await saveFormula(store, dir, column("f", "F", "a + b"));

  const entries = await readdir(dir);
  expect(entries).toEqual(["f.unof"]);
});

test("a write replaces the previous file rather than appending to it", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await saveFormula(store, dir, column("f", "F", "a + b"));
  await saveFormula(store, dir, column("f", "F", "c * d"));

  const text = await readFile(join(dir, "f.unof"), "utf8");
  expect(text).toContain("c * d");
  expect(text).not.toContain("a + b");
  expect(await readdir(dir)).toEqual(["f.unof"]);
});

// An id is checked before it is ever joined to a path, so a formula somebody
// sent cannot write outside the directory it was meant for.
test("an id that names a path never reaches the filesystem", async () => {
  const store = nodeStore();
  const dir = await scratch();

  await expect(saveFormula(store, dir, column("../escape", "Escape", "a"))).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
});

// The library is read the way every other file is, through its store's
// handlers. A store that lists none cannot read a formula, and says why.
test("formulas are read through the store's handlers, and nothing else", async () => {
  const store = nodeStore();
  const dir = await scratch();
  await saveFormula(store, dir, column("f", "F", "a + b"));

  const { formulas, failed } = await loadLibrary({ ...store, files: [] }, dir);
  expect(formulas).toEqual([]);
  expect(failed[0]!.message).toContain("f.unof: nothing here opens it");
});
