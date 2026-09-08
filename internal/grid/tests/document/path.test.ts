// Where a .uno writes a source's path down, and where it reads it back from.
//
// The rule is one line: relative where the file sits under the workspace's own
// folder, absolute everywhere else. What these pin is that "under" is honest --
// a sibling folder whose name starts the same way is not under it -- and that a
// path written on one platform still resolves on the other.

import { expect, test } from "vite-plus/test";

import { against, baseOf, dirOf, isAbsolute, relativeTo } from "../../src/document/index.ts";
import { resolvedPath, storedPath } from "../../src/document/index.ts";

test("a path under the workspace's folder is written down relative to it", () => {
  expect(storedPath("/home/cpa/q4/sales.csv", "/home/cpa/q4/books.uno")).toBe("sales.csv");
  expect(storedPath("/home/cpa/q4/exports/ads.csv", "/home/cpa/q4/books.uno")).toBe(
    "exports/ads.csv",
  );
});

// Reaching up with .. would buy one more layout and cost every reader an
// opinion about what a path means.
test("a path anywhere else is written down absolute", () => {
  expect(storedPath("/mnt/data/ledger.csv", "/home/cpa/q4/books.uno")).toBe("/mnt/data/ledger.csv");
  expect(storedPath("/home/cpa/q3/sales.csv", "/home/cpa/q4/books.uno")).toBe(
    "/home/cpa/q3/sales.csv",
  );
  // A sibling folder that starts with the same letters is not inside it.
  expect(storedPath("/home/cpa/q4-old/sales.csv", "/home/cpa/q4/books.uno")).toBe(
    "/home/cpa/q4-old/sales.csv",
  );
});

test("a relative path is read back from the folder the workspace is in", () => {
  expect(resolvedPath("sales.csv", "/home/cpa/q4/books.uno")).toBe("/home/cpa/q4/sales.csv");
  expect(resolvedPath("exports/ads.csv", "/home/cpa/q4/books.uno")).toBe(
    "/home/cpa/q4/exports/ads.csv",
  );
  expect(resolvedPath("/mnt/data/ledger.csv", "/home/cpa/q4/books.uno")).toBe(
    "/mnt/data/ledger.csv",
  );
});

// The two together are the property the whole thing rests on: copy the folder,
// and the workspace still finds its sources.
test("a folder moved whole still resolves every path it wrote", () => {
  const was = "/home/cpa/q4/books.uno";
  const now = "/media/stick/q4/books.uno";
  const file = "/home/cpa/q4/exports/ads.csv";

  expect(resolvedPath(storedPath(file, was), now)).toBe("/media/stick/q4/exports/ads.csv");
});

// A .uno travels between machines, and so do the paths in it.
test("a path written on one platform reads on the other", () => {
  expect(storedPath("C:\\books\\q4\\sales.csv", "C:\\books\\q4\\books.uno")).toBe("sales.csv");
  expect(storedPath("C:\\books\\q4\\exports\\ads.csv", "C:\\books\\q4\\books.uno")).toBe(
    "exports/ads.csv",
  );
  expect(against("exports/ads.csv", "C:\\books\\q4")).toBe("C:\\books\\q4/exports/ads.csv");
  expect(isAbsolute("C:\\books\\sales.csv")).toBe(true);
  expect(isAbsolute("\\\\share\\books\\sales.csv")).toBe(true);
  expect(isAbsolute("exports/ads.csv")).toBe(false);
});

// A browser has no folders to read a relative path from. It comes back as it
// was written and fails to open under its own name, which is the truth.
test("with nowhere to read it from, a relative path stays as it is", () => {
  expect(resolvedPath("sales.csv", "")).toBe("sales.csv");
  expect(storedPath("/home/cpa/q4/sales.csv", "")).toBe("/home/cpa/q4/sales.csv");
});

test("a path splits into its folder and its name, either way round", () => {
  expect(dirOf("/home/cpa/q4/sales.csv")).toBe("/home/cpa/q4");
  expect(dirOf("C:\\books\\sales.csv")).toBe("C:\\books");
  expect(dirOf("sales.csv")).toBe("");
  expect(baseOf("/home/cpa/q4/sales.csv")).toBe("sales.csv");
  expect(baseOf("C:\\books\\sales.csv")).toBe("sales.csv");
  expect(baseOf("sales.csv")).toBe("sales.csv");
  expect(relativeTo("/home/cpa/q4/sales.csv", "/home/cpa/q4")).toBe("sales.csv");
  expect(relativeTo("/home/cpa/q4", "/home/cpa/q4"), "a folder is not under itself").toBe("");
});
