// Tests for how a .uno stores and resolves source paths: relative when the
// file is under the workspace's folder, absolute otherwise. Windows and POSIX
// paths are both handled.

import { expect, test } from "vite-plus/test";

import {
  against,
  baseOf,
  dirOf,
  isAbsolute,
  relativeTo,
  resolvedPath,
  samePath,
  storedPath,
} from "../../src/document/index.ts";

test("a path under the workspace's folder is written down relative to it", () => {
  expect(storedPath("/home/cpa/q4/sales.csv", "/home/cpa/q4/books.uno")).toBe("sales.csv");
  expect(storedPath("/home/cpa/q4/exports/ads.csv", "/home/cpa/q4/books.uno")).toBe(
    "exports/ads.csv",
  );
});

// Paths outside the workspace folder are stored absolute.
test("a path anywhere else is written down absolute", () => {
  expect(storedPath("/mnt/data/ledger.csv", "/home/cpa/q4/books.uno")).toBe("/mnt/data/ledger.csv");
  expect(storedPath("/home/cpa/q3/sales.csv", "/home/cpa/q4/books.uno")).toBe(
    "/home/cpa/q3/sales.csv",
  );
  // A sibling folder with the same name prefix is outside the workspace folder.
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

// storedPath then resolvedPath against a moved workspace finds the moved file.
test("a folder moved whole still resolves every path it wrote", () => {
  const was = "/home/cpa/q4/books.uno";
  const now = "/media/stick/q4/books.uno";
  const file = "/home/cpa/q4/exports/ads.csv";

  expect(resolvedPath(storedPath(file, was), now)).toBe("/media/stick/q4/exports/ads.csv");
});

// Windows paths are stored with forward slashes and resolve on either platform.
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

// With an empty workspace path, paths are returned unchanged.
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

test("two paths are the same place whichever way their slashes lean", () => {
  expect(samePath("C:\\data\\q4\\sales.csv", "C:/data/q4/sales.csv")).toBe(true);
  expect(samePath("/home/cpa/q4/sales.csv", "/home/cpa/q4/sales.csv")).toBe(true);
  expect(samePath("/home/cpa/q4/sales.csv", "/home/cpa/q4/Sales.csv")).toBe(false);
  expect(samePath("/home/cpa/q4/sales.csv", "/home/cpa/q4")).toBe(false);
});
