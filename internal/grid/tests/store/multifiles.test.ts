// PartsRef: several files named as one source, claimed by multiFiles and
// opened through the handlers beside it.
//
// A build of single-file handlers only refuses the ref by name, and a part
// in a bucket is signed by the connection covering it.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import type { Connection } from "../../src/library/index.ts";
import { sources } from "../../src/plugin/index.ts";
import {
  blobFiles,
  bytesSource,
  connectionsIn,
  multiFiles,
  multiOf,
  multiProvider,
  openWith,
  saveConnection,
} from "../../src/store/index.ts";
import type { FileHandler, FileRef, PartsRef, SingleRef } from "../../src/store/index.ts";
import { connectionSigning, diskProvider, localFiles, nodeStore } from "../../src/store/node.ts";
import { connectionMeeting, s3Provider } from "../../src/store/s3.ts";
import { TINY, connect, indexed, openOne, sales, sheetRows, widened } from "../engine/harness.ts";
import { ROWS, bytes } from "../testdata/sales-q3.ts";
import { PARTS, PART_FIXTURES, PART_NAMES, partBytes } from "../testdata/sales-q3-parts.ts";
import { HOME_REGION } from "./regions.ts";
import { bucket } from "./standin.ts";
import type { Bucket } from "./standin.ts";
import { FINANCE, MARKETING, profilesEnv, twoProfiles } from "./profiles.ts";

/** What the three parts are called as one source. */
const NAME = "sales-q3";

/** The path prefix of a file held in memory. */
const MEMORY = "memory://";

/** How many rows are compared at a time. */
const PAGE = 500;

/** The fixture's three parts on disk, as one ref. */
const ON_DISK: PartsRef = {
  name: NAME,
  parts: PART_FIXTURES.map((path, i) => ({ ref: { name: PART_NAMES[i]!, path } })),
  header: "first",
};

/** A handler over the fixture's parts held in memory, which remembers every ref it opened. */
function memory(): { handler: FileHandler; refs: FileRef[] } {
  const held = new Map(PART_NAMES.map((name, i) => [name, partBytes[i]!]));
  const refs: FileRef[] = [];
  const handler: FileHandler = {
    label: "memory",
    handles: (ref) => "path" in ref && ref.path.startsWith(MEMORY),
    open(ref) {
      const file = held.get(ref.name);
      if (file === undefined) return Promise.reject(new Error(`${ref.name}: no such file`));
      refs.push(ref);
      return Promise.resolve({ ...bytesSource(file), version: `"${ref.name}"` });
    },
  };
  return { handler, refs };
}

function inMemory(name: string): SingleRef {
  return { name, path: MEMORY + name };
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

test("multiFiles claims a ref of parts and no other", () => {
  const multi = multiFiles([localFiles()]);
  expect(multi.label).toBe("several files as one");
  expect(multi.handles(ON_DISK)).toBe(true);
  expect(multi.handles({ name: "a.csv", path: "/tmp/a.csv" })).toBe(false);
  expect(multi.handles({ name: "a.csv", path: "s3://acme/a.csv" })).toBe(false);
  expect(multi.handles({ name: "a.csv", blob: new Blob([]) })).toBe(false);
  // And each single-file handler leaves a ref of several alone.
  for (const one of [localFiles(), blobFiles()]) expect(one.handles(ON_DISK)).toBe(false);
});

test("a ref of parts opens through the handlers as the whole file", async () => {
  const single = [localFiles()];
  const source = await openWith([...single, multiFiles(single)], ON_DISK);
  try {
    expect(same(await source.read(0, source.size), bytes)).toBe(true);
  } finally {
    await source.close();
  }
});

test("multiOf hands back the map, the extents and each part's version", async () => {
  const m = memory();
  const ref: PartsRef = {
    name: NAME,
    parts: PART_NAMES.map((n) => ({ ref: inMemory(n) })),
    header: "first",
  };
  const source = await openWith([m.handler, multiFiles([m.handler])], ref);
  try {
    const multi = multiOf(source);
    expect(multi).toBeDefined();
    expect(multi!.map.size).toBe(source.size);
    expect(multi!.map.spans.map((s) => s.part)).toEqual([0, 1, 2]);
    expect(multi!.extents.map((e) => e.bytes)).toEqual(partBytes.map((b) => b.length));
    expect(await multi!.versions()).toEqual(PART_NAMES.map((n) => `"${n}"`));
  } finally {
    await source.close();
  }

  // A single-file source's multi is undefined.
  const one = await openWith([m.handler], inMemory(PART_NAMES[0]!));
  expect(multiOf(one)).toBeUndefined();
});

// A ref carrying extents and versions, as a save keeps it, opens with every
// part left closed. Each part is asked for with its recorded version.
test("a ref carrying extents and versions opens without touching a part", async () => {
  const first = memory();
  const fresh: PartsRef = {
    name: NAME,
    parts: PART_NAMES.map((n) => ({ ref: inMemory(n) })),
    header: "first",
  };
  const measured = multiOf(await openWith([multiFiles([first.handler])], fresh))!;
  const versions = await measured.versions();
  const saved: PartsRef = {
    ...fresh,
    parts: fresh.parts.map((part, i) => ({
      ref: { ...inMemory(part.ref.name), version: versions[i] },
      extent: measured.extents[i]!,
    })),
  };
  await measured.close();

  // Round-tripped through JSON, as a save does.
  const restored = JSON.parse(JSON.stringify(saved)) as PartsRef;
  const again = memory();
  const source = await openWith([multiFiles([again.handler])], restored);
  try {
    expect(source.size).toBe(bytes.length);
    expect(again.refs).toEqual([]);

    const last = multiOf(source)!.map.spans[PARTS - 1]!;
    expect(
      same(await source.read(last.start, last.end - last.start), bytes.subarray(last.start)),
    ).toBe(true);
    // The part read and the first part, for its header, were opened with
    // their recorded versions. The middle part stayed closed.
    expect(again.refs.toSorted((x, y) => x.name.localeCompare(y.name))).toEqual(
      [0, PARTS - 1].map((i) => ({ ...inMemory(PART_NAMES[i]!), version: versions[i] })),
    );
  } finally {
    await source.close();
  }
});

test("a build that does not list multiFiles refuses a ref of parts by name", async () => {
  await expect(openWith([localFiles(), blobFiles()], ON_DISK)).rejects.toThrow(
    "sales-q3: nothing here opens several files as one · this build reads local files, dropped files",
  );
  await expect(openWith([], ON_DISK)).rejects.toThrow(
    "sales-q3: nothing here opens several files as one · this build reads nothing",
  );
  // One file is still refused the way it was.
  await expect(openWith([blobFiles()], { name: "a.csv", path: "/tmp/a.csv" })).rejects.toThrow(
    "/tmp/a.csv: nothing here opens it · this build reads dropped files",
  );
});

test("a part no handler under it claims is refused, naming the part", async () => {
  const blob: SingleRef = { name: PART_NAMES[1]!, blob: new Blob([partBytes[1]!.slice()]) };
  const ref: PartsRef = { ...ON_DISK, parts: ON_DISK.parts.with(1, { ref: blob }) };
  await expect(openWith([multiFiles([localFiles()])], ref)).rejects.toThrow(
    `${PART_NAMES[1]} (part 2 of ${PARTS}): ${PART_NAMES[1]}: nothing here opens it · this build reads local files`,
  );
});

// A nested PartsRef, which the type rules out, is refused at run time too.
test("a part that is several files itself is refused, named", async () => {
  const nested = JSON.parse(
    JSON.stringify({
      ...ON_DISK,
      parts: [ON_DISK.parts[0], { ref: { ...ON_DISK, name: "inner" } }],
    }),
  ) as PartsRef;
  const single = [localFiles()];
  await expect(openWith([...single, multiFiles(single)], nested)).rejects.toThrow(
    "sales-q3: inner (part 2 of 2) is several files itself · a part is one file",
  );
});

test("a ref with no parts is refused by name", async () => {
  await expect(openWith([multiFiles([localFiles()])], { ...ON_DISK, parts: [] })).rejects.toThrow(
    "sales-q3 has no parts · several files read as one needs at least one",
  );
});

test("handed one file, multiFiles says it is not its own", async () => {
  await expect(
    multiFiles([localFiles()]).open({ name: "a.csv", path: "/tmp/a.csv" }),
  ).rejects.toThrow("a.csv: not several files read as one");
});

test("multiProvider reads through the providers it is handed, and browses nothing", async () => {
  const provider = multiProvider([diskProvider()]);
  expect(provider).toMatchObject({ name: "multi", label: "several files as one" });
  expect(provider.browse).toBeUndefined();
  const source = await sources([diskProvider(), provider]).open(ON_DISK);
  try {
    expect(source.size).toBe(bytes.length);
  } finally {
    await source.close();
  }
});

// ------------------------------------------------------------ connections

const FINANCE_BUCKET = "acme-finance";
const MARKETING_BUCKET = "acme-marketing";

let b: Bucket;
let aws: string;

beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, undefined, {
    [FINANCE_BUCKET]: { objects: new Map([[PART_NAMES[1]!, partBytes[1]!]]), keys: FINANCE },
    [MARKETING_BUCKET]: { objects: new Map([[PART_NAMES[2]!, partBytes[2]!]]), keys: MARKETING },
  });
  aws = await twoProfiles();
});

afterAll(() => b.close());

/** A machine with the two profiles, and only those, to sign in with. */
function env(): Record<string, string | undefined> {
  return profilesEnv(aws);
}

function connection(id: string, bucketName: string, profile: string): Connection {
  return {
    format: 1,
    id,
    name: id,
    provider: "s3",
    bucket: bucketName,
    prefix: "",
    auth: { mode: "profile", profile },
    created: undefined,
    modified: undefined,
  };
}

/** One part on disk and one in each bucket, as one ref. */
const ACROSS: PartsRef = {
  name: NAME,
  parts: [
    { ref: { name: PART_NAMES[0]!, path: PART_FIXTURES[0]! } },
    { ref: { name: PART_NAMES[1]!, path: `s3://${FINANCE_BUCKET}/${PART_NAMES[1]}` } },
    { ref: { name: PART_NAMES[2]!, path: `s3://${MARKETING_BUCKET}/${PART_NAMES[2]}` } },
  ],
  header: "first",
};

/** An engine wired the way the desktop's is, with multiProvider listed. */
async function engine(saved: Connection[]) {
  const dir = await mkdtemp(join(tmpdir(), "uno-multifiles-connections-"));
  const store = nodeStore();
  for (const c of saved) await saveConnection(store, dir, c);
  const kept = connectionsIn(store, dir);
  const single = [
    diskProvider(),
    s3Provider({ credentials: connectionSigning(() => kept.all, env()), endpoint: b.endpoint }),
  ];
  return connect(TINY, [...single, multiProvider(single)], {
    connections: kept,
    meet: connectionMeeting(() => kept.all),
  });
}

/** The access keys the requests to one bucket from `from` on were signed with, once each. */
function keysFor(bucketName: string, from: number): string[] {
  const mine = b.seen.slice(from).filter((r) => r.path.startsWith(`/${bucketName}/`));
  return [...new Set(mine.map((r) => r.key))];
}

test("each part in a bucket is read as the connection covering it", async () => {
  const from = b.seen.length;
  const { engine: e, done } = await engine([
    connection("finance", FINANCE_BUCKET, "finance"),
    connection("marketing", MARKETING_BUCKET, "marketing"),
  ]);
  try {
    const src = await openOne(e, ACROSS);
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    for (let first = 0; first < ROWS; first += PAGE) {
      const { rows } = await src.rows(first, PAGE);
      expect(widened(rows), `rows from ${first}`).toEqual(sheetRows(sales, first, PAGE, "raw"));
    }
    expect(keysFor(FINANCE_BUCKET, from)).toEqual([FINANCE.accessKeyId]);
    expect(keysFor(MARKETING_BUCKET, from)).toEqual([MARKETING.accessKeyId]);
  } finally {
    done();
  }
});

// The single-object refusal, with the part named in front.
test("a part whose connection cannot read it is refused, naming the part and the connection", async () => {
  const { engine: e, done } = await engine([
    connection("finance", FINANCE_BUCKET, "finance"),
    connection("wrong", MARKETING_BUCKET, "finance"),
  ]);
  try {
    await expect(e.open(ACROSS)).rejects.toThrow(
      `${PART_NAMES[2]} (part 3 of ${PARTS}): s3://${MARKETING_BUCKET}/${PART_NAMES[2]}: access denied · wrong (the AWS profile finance) cannot read it`,
    );
  } finally {
    done();
  }
});
