// A provider is plugged in whole, and the two lists are derived from it.
//
// What is under test is that wiring a provider once wires both capabilities,
// that a provider with nothing to browse contributes no lister rather than an
// empty one, and that both refusals come out of the same sentence.

import { expect, test } from "vite-plus/test";

import type { Provider } from "../../src/plugin/index.ts";
import { sources } from "../../src/plugin/index.ts";
import type { Entry, Lister } from "../../src/store/index.ts";
import { blobProvider } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { FIXTURE, bytes } from "../engine/harness.ts";

/** A stand-in bucket: claims s3://, and lists and stats without a network. */
function bucketProvider(): Provider {
  const browse: Lister = {
    label: "S3",
    handles: (path) => path.startsWith("s3://"),
    list: (path) => Promise.resolve({ entries: [entry(path + "a.csv")] }),
    stat: (path) => Promise.resolve(entry(path)),
  };
  return {
    name: "s3",
    label: "S3",
    files: {
      label: "S3",
      handles: (ref) => "path" in ref && ref.path.startsWith("s3://"),
      open: () => Promise.reject(new Error("not opened in this test")),
    },
    browse,
  };
}

function entry(path: string): Entry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, folder: false, bytes: 7 };
}

test("wiring a provider wires both of its capabilities", () => {
  const s3 = bucketProvider();
  const store = sources([diskProvider(), s3]);

  expect(store.files.map((f) => f.label)).toEqual(["local files", "S3"]);
  expect(store.browsers.map((l) => l.label)).toEqual(["S3"]);
});

// A Blob is a file and nothing around it. A provider with nothing to browse
// contributes no lister, rather than one that answers with an empty folder.
test("a provider with nothing to browse contributes no lister", () => {
  const store = sources([blobProvider()]);

  expect(store.files).toHaveLength(1);
  expect(store.browsers).toEqual([]);
});

// The disk lister is task 1.2. Until it exists the disk provider can open and
// cannot browse, and that is the shape the registry is meant to carry.
test("a provider whose lister is not built yet opens and refuses to browse", async () => {
  const store = sources([diskProvider()]);

  expect(await store.open({ name: "sales-q3.csv", path: FIXTURE }).then((f) => f.size)).toBe(
    bytes.length,
  );
  await expect(store.list("/home/jo/")).rejects.toThrow(
    "/home/jo/: nothing here browses it · this build browses nothing",
  );
});

test("the registry lists and stats through the provider that claims the path", async () => {
  const store = sources([diskProvider(), bucketProvider()]);

  const listing = await store.list("s3://acme/exports/");
  expect(listing.entries.map((e) => e.path)).toEqual(["s3://acme/exports/a.csv"]);
  expect((await store.stat("s3://acme/exports/a.csv")).bytes).toBe(7);
});

// Both refusals are one sentence with two words swapped, so neither can drift
// away from the other again.
test("opening and browsing refuse the same way", async () => {
  const store = sources([diskProvider(), bucketProvider()]);

  await expect(store.open({ name: "x.csv", blob: new Blob([bytes]) })).rejects.toThrow(
    "x.csv: nothing here opens it · this build reads local files, S3",
  );
  await expect(store.list("gs://acme/")).rejects.toThrow(
    "gs://acme/: nothing here browses it · this build browses S3",
  );
});

// The refusal names what the build can reach, and a build that can reach
// nothing says so instead of trailing off after the verb.
test("a registry with no providers refuses both ways", async () => {
  const store = sources([]);

  await expect(store.open({ name: "a.csv", path: "/tmp/a.csv" })).rejects.toThrow(
    "/tmp/a.csv: nothing here opens it · this build reads nothing",
  );
  await expect(store.stat("/tmp/a.csv")).rejects.toThrow(
    "/tmp/a.csv: nothing here browses it · this build browses nothing",
  );
});
