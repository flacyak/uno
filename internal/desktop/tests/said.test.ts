// What the engine says, written by the desktop: one message for each kind.
//
// The engine has its own English for every kind, which is what its errors and
// its logs read. The desktop's English is in the message file. They are two
// sentences for one thing, so they are held together here: a sample of every
// kind, said both ways, has to come out the same.
//
// The samples are keyed by kind, and the type asks for every kind there is. A
// kind the engine gains fails to compile here until it has a sample, the same
// way it fails in `say` until it has a message.

import { beforeEach, describe, expect, test } from "vite-plus/test";

import { Refusal, english } from "@uno/grid/engine";
import type { Said } from "@uno/grid/engine";

import { PSEUDO_LOCALE, PSEUDO_OPEN } from "../scripts/pseudo.js";
import { baseLocale, setLocale } from "../src/paraglide/runtime.js";
import { said, say } from "../src/renderer/said.ts";

const KB = 1024;
const MB = KB * KB;

const SAMPLES: { [K in Said["t"]]: Extract<Said, { t: K }> } = {
  text: { t: "text", text: "ENOENT: no such file or directory" },
  about: { t: "about", subject: "q4.uno", why: { t: "nothing-to-undo" } },
  replaying: { t: "replaying", name: "ads.csv", why: { t: "in-view" } },
  read: { t: "read", delimiter: ";", header: "none", charset: "UTF-8" },
  program: {
    t: "program",
    steps: [
      { t: "trim" },
      { t: "remove", what: { t: "chars", names: ["commas", "spaces"], where: "end" } },
      { t: "replace", what: { t: "literal", text: "N/A" }, with: "0" },
    ],
  },
  "version-changed": { t: "version-changed", name: "ads.csv", sizes: { now: 3 * MB, was: 2 * MB } },
  "size-changed": { t: "size-changed", name: "ads.csv", now: 40 * KB, was: 12 * KB },
  "only-source": { t: "only-source", name: "ads.csv" },
  "append-to-absent": { t: "append-to-absent", name: "ads.csv" },
  "append-to-one-file": { t: "append-to-one-file", name: "ads.csv" },
  "append-nothing": { t: "append-nothing", name: "ads.csv" },
  "append-already-part": { t: "append-already-part", file: "q3.csv", part: 2, name: "sales" },
  "append-twice": { t: "append-twice", file: "q3.csv", name: "sales" },
  "workspace-as-source": { t: "workspace-as-source", name: "q4.uno" },
  "workspace-too-large": {
    t: "workspace-too-large",
    name: "q4.uno",
    bytes: 300 * MB,
    limit: 256 * MB,
  },
  "no-file-open": { t: "no-file-open" },
  "carried-too-large": {
    t: "carried-too-large",
    name: "ads.csv",
    bytes: 300 * MB,
    limit: 256 * MB,
  },
  "carried-together-too-large": {
    t: "carried-together-too-large",
    count: 3,
    bytes: 300 * MB,
    limit: 256 * MB,
  },
  "workspace-closed": { t: "workspace-closed" },
  "no-such-source": { t: "no-such-source", id: "ads" },
  "source-absent": { t: "source-absent", name: "ads.csv" },
  "point-one-at-several": { t: "point-one-at-several", file: "parts", count: 3, name: "ads.csv" },
  "point-several-at-one": { t: "point-several-at-one", name: "sales", count: 3, file: "q3.csv" },
  "point-several-at-other": { t: "point-several-at-other", name: "sales", count: 3, given: 2 },
  "log-lost-edit": { t: "log-lost-edit", source: "ads" },
  "bucket-unconnected": { t: "bucket-unconnected", container: "q4.uno", bucket: "acme-exports" },
  "joins-unknown-for-column": { t: "joins-unknown-for-column", name: "sales" },
  "joins-unknown-for-save": { t: "joins-unknown-for-save", name: "sales", count: 3 },
  "rows-past-files": { t: "rows-past-files", name: "sales" },
  "part-has-no-path": { t: "part-has-no-path", name: "sales", file: "q3.csv", part: 2, count: 3 },
  "nothing-to-undo": { t: "nothing-to-undo" },
  "nothing-to-redo": { t: "nothing-to-redo" },
  "in-view": { t: "in-view" },
  "file-closed": { t: "file-closed" },
  "changed-on-disk": { t: "changed-on-disk", name: "ads.csv" },
  "keeps-no-connections": { t: "keeps-no-connections" },
  "offers-no-profiles": { t: "offers-no-profiles" },
  "tries-no-connection": { t: "tries-no-connection" },
};

const samples = Object.values(SAMPLES).map((sample): [string, Said] => [sample.t, sample]);

beforeEach(() => {
  void setLocale(baseLocale, { reload: false });
});

describe.each(samples)("%s", (_kind, sample) => {
  test("is said in English as the engine says it", () => {
    expect(say(sample)).toBe(english(sample));
  });

  test("is said through a message in every other language", () => {
    void setLocale(PSEUDO_LOCALE, { reload: false });
    // A diagnostic with no kind of its own is passed on as it was written.
    if (sample.t === "text") expect(say(sample)).toBe(sample.text);
    else expect(say(sample).startsWith(PSEUDO_OPEN)).toBe(true);
  });
});

test("the other shapes of a kind are the engine's English too", () => {
  const shapes: Said[] = [
    { t: "read", delimiter: ",", header: "first", charset: "UTF-8" },
    { t: "read", delimiter: ";", header: "first", charset: "Windows-1252" },
    { t: "read", delimiter: "\t", header: "first", charset: "UTF-8" },
    { t: "read", delimiter: "\t", header: "none", charset: "UTF-8" },
    { t: "program", steps: [] },
    { t: "program", steps: [{ t: "upper" }, { t: "lower" }] },
    { t: "program", steps: [{ t: "notation", text: "slice(0, 2)" }] },
    {
      t: "program",
      steps: [{ t: "remove", what: { t: "chars", names: ["commas"], where: "start" } }],
    },
    {
      t: "program",
      steps: [
        { t: "replace", what: { t: "chars", names: ["dashes"], where: "anywhere" }, with: "/" },
      ],
    },
    { t: "version-changed", name: "ads.csv" },
    { t: "carried-too-large", name: "ads.csv", bytes: 2 * KB * MB, limit: 256 * MB },
  ];
  for (const shape of shapes) expect(say(shape), JSON.stringify(shape)).toBe(english(shape));
});

test("text a step looks for is quoted with what cannot be seen in it escaped", () => {
  const tab: Said = {
    t: "program",
    steps: [{ t: "remove", what: { t: "literal", text: "a\tb" } }],
  };
  expect(say(tab)).toBe('remove "a\\tb"');
  expect(say(tab)).toBe(english(tab));
});

test("an error from the engine is said through its message, and any other as it was written", () => {
  expect(said(new Refusal({ t: "nothing-to-undo" }))).toBe("there is nothing to undo");
  expect(said(new Error("EACCES: permission denied"))).toBe("EACCES: permission denied");
  expect(said("a string was thrown")).toBe("a string was thrown");

  void setLocale(PSEUDO_LOCALE, { reload: false });
  expect(said(new Refusal({ t: "nothing-to-undo" })).startsWith(PSEUDO_OPEN)).toBe(true);
});
