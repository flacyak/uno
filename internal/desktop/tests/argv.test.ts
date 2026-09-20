/**
 * @fileoverview The file paths read off a command line, for the first uno and
 * for one started while it runs.
 */

import { expect, test } from "vite-plus/test";

import { filesNamed } from "@main/argv";

const CWD = "/home/ana/exports";
/** The app path of the packaged app, which is never on the line. */
const PACKAGED = "/opt/uno/resources/app.asar";
/** The app in development, started as `electron .` from its own folder. */
const DEV = "/home/ana/uno/internal/desktop";

test("a packaged uno takes every argument after the executable", () => {
  const argv = ["/usr/bin/uno", "q3.csv", "/data/q4.csv"];
  expect(filesNamed(argv, CWD, PACKAGED)).toEqual(["/home/ana/exports/q3.csv", "/data/q4.csv"]);
});

test("in development the app path is dropped, wherever it is and however it is written", () => {
  expect(filesNamed(["/usr/bin/electron", ".", "q3.csv"], DEV, DEV)).toEqual([`${DEV}/q3.csv`]);
  // A second uno's line arrives with the switches first and the app after them.
  const second = ["/usr/bin/electron", "--user-data-dir=/tmp/data", DEV, "/data/q4.csv"];
  expect(filesNamed(second, CWD, DEV)).toEqual(["/data/q4.csv"]);
  expect(filesNamed(["/usr/bin/electron", "../desktop", "q3.csv"], DEV, DEV)).toEqual([
    `${DEV}/q3.csv`,
  ]);
});

test("switches are dropped, and a line that names no file is empty", () => {
  const argv = ["/usr/bin/uno", "--user-data-dir=/tmp/data", "q3.csv", "--lang=en-US"];
  expect(filesNamed(argv, CWD, PACKAGED)).toEqual(["/home/ana/exports/q3.csv"]);
  expect(filesNamed(["/usr/bin/uno", "--lang=en-US"], CWD, PACKAGED)).toEqual([]);
});

test("a relative path is resolved against the directory the line was typed in", () => {
  const argv = ["/usr/bin/uno", "../q3.csv"];
  expect(filesNamed(argv, CWD, PACKAGED)).toEqual(["/home/ana/q3.csv"]);
});
