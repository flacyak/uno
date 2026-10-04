// Browsing over the protocol: `list`, `stat` and `peek`. These requests stand
// apart from any source. They go to the listers and handlers the engine was
// wired with, outside the workspace queue, so they are answered while a save
// runs.
//
// The first half sends raw messages over the channel and checks which reply
// comes back, with which id, in what order. The second half goes through the
// Engine client.
//
// Every listing browses a temp directory with the testdata fixtures copied
// into it. The sizes checked are those copies' sizes.

import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { english, messagePort, serve } from "../../src/engine/index.ts";
import type { MessagePortLike, Reply, Request } from "../../src/engine/index.ts";
import { sources } from "../../src/plugin/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { blobProvider, blobSource } from "../../src/store/index.ts";
import type { ByteSource, FileRef } from "../../src/store/index.ts";
import { diskLister } from "../../src/store/disklister.ts";
import { diskProvider, localFiles } from "../../src/store/node.ts";
import { bytes, connect, FIXTURE, openOne } from "./harness.ts";

const TESTDATA = fileURLToPath(new URL("../testdata/", import.meta.url));

/** The fixtures copied into the folder, and the folders made beside them. */
const FILES = ["sales-q3.csv", "google-ads-sales.csv", "unit-margin.unof"];
const FOLDERS = ["archive", "reports"];

/** The listing order: folders first, then by name. */
const ORDER = ["archive", "reports", "google-ads-sales.csv", "sales-q3.csv", "unit-margin.unof"];

/** folder makes a temp directory with three fixtures and two folders. */
async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uno-browse-"));
  for (const name of FOLDERS) await mkdir(join(dir, name));
  for (const name of FILES) await copyFile(join(TESTDATA, name), join(dir, name));
  return dir;
}

/** paged is the disk provider with a lister of `page` entries per page. */
function paged(page: number): Provider {
  return { name: "disk", label: "local files", files: localFiles(), browse: diskLister(page) };
}

// ------------------------------------------------------------ the raw channel

/** A raw client over the channel: sends requests and keeps every reply. */
interface Wire {
  send(req: Request): void;
  /** Every reply, in the order the engine sent them. */
  seen: Reply[];
  /** The reply with this id, once it lands. */
  reply(id: number): Promise<Reply>;
  /** The first reply `is` picks out, already seen or still to come. */
  when(is: (msg: Reply) => boolean): Promise<Reply>;
  close(): void;
}

function wire(providers: Provider[]): Wire {
  const { port1, port2 } = new MessageChannel();
  serve(messagePort<Request, Reply>(port1 as unknown as MessagePortLike), sources(providers));
  const client = messagePort<Reply, Request>(port2 as unknown as MessagePortLike);

  const seen: Reply[] = [];
  const waiting = new Map<number, (msg: Reply) => void>();
  const watching: Array<[(msg: Reply) => boolean, (msg: Reply) => void]> = [];
  client.listen((msg) => {
    seen.push(msg);
    if ("id" in msg && msg.id !== undefined) waiting.get(msg.id)?.(msg);
    for (const [is, resolve] of watching.splice(0)) {
      if (is(msg)) resolve(msg);
      else watching.push([is, resolve]);
    }
  });

  return {
    send: (req) => client.post(req),
    seen,
    reply: (id) => new Promise((resolve) => waiting.set(id, resolve)),
    when: (is) => {
      const already = seen.find(is);
      if (already !== undefined) return Promise.resolve(already);
      return new Promise((resolve) => watching.push([is, resolve]));
    },
    // As Engine.close does: post a close request, then close this end only.
    close: () => {
      client.post({ t: "close" });
      client.close();
    },
  };
}

test("a list request comes back as one page of the folder", async () => {
  const dir = await folder();
  const w = wire([paged(1000)]);
  try {
    w.send({ t: "list", id: 1, path: dir });
    const r = await w.reply(1);

    expect(r.t).toBe("listed");
    if (r.t !== "listed") return;
    expect(r.listing.entries.map((e) => e.name)).toEqual(ORDER);
    // An entry carries a path and size, as a FileRef needs.
    expect(r.listing.entries.map((e) => e.path)).toEqual(ORDER.map((n) => join(dir, n)));
    expect(r.listing.entries.find((e) => e.name === "sales-q3.csv")?.bytes).toBe(bytes.length);
    // Five entries fit in one page, so `next` is undefined.
    expect(r.listing.next).toBeUndefined();
  } finally {
    w.close();
  }
});

// The cursor is passed back to the lister unchanged.
test("the cursor goes to the lister as it came, and pages the folder once", async () => {
  const dir = await folder();
  const w = wire([paged(2)]);
  try {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let id = 1; id <= ORDER.length; id++) {
      w.send({ t: "list", id, path: dir, cursor });
      const r = await w.reply(id);
      if (r.t !== "listed") throw new Error(`the engine answered a list with ${r.t}`);
      names.push(...r.listing.entries.map((e) => e.name));
      cursor = r.listing.next;
      if (cursor === undefined) break;
    }

    expect(cursor).toBeUndefined();
    expect(names).toEqual(ORDER);
  } finally {
    w.close();
  }
});

test("a stat request answers with the size and the time the file has now", async () => {
  const dir = await folder();
  const w = wire([paged(1000)]);
  try {
    w.send({ t: "stat", id: 1, path: join(dir, "sales-q3.csv") });
    const r = await w.reply(1);

    expect(r.t).toBe("statted");
    if (r.t !== "statted") return;
    expect(r.entry).toMatchObject({ name: "sales-q3.csv", folder: false, bytes: bytes.length });
    // A Date crosses the channel as a Date.
    expect(r.entry.modified).toBeInstanceOf(Date);
  } finally {
    w.close();
  }
});

test("a path nothing browses is refused by name, against the id that asked", async () => {
  const w = wire([paged(1000)]);
  try {
    w.send({ t: "list", id: 7, path: "gs://acme/exports/" });
    const r = await w.reply(7);

    expect(r).toEqual({
      t: "error",
      id: 7,
      said: {
        t: "text",
        text: "gs://acme/exports/: nothing here browses it · this build browses local files",
      },
    });
  } finally {
    w.close();
  }
});

test("an engine whose providers cannot browse refuses to browse at all", async () => {
  const w = wire([blobProvider()]);
  try {
    w.send({ t: "stat", id: 1, path: "/home/jo/q3.csv" });
    const r = await w.reply(1);

    expect(r).toMatchObject({
      t: "error",
      id: 1,
      said: {
        t: "text",
        text: "/home/jo/q3.csv: nothing here browses it · this build browses nothing",
      },
    });
  } finally {
    w.close();
  }
});

// ------------------------------------------------------------ outside the queue

/**
 * held is a blob provider whose reads wait while `hold` is in effect. A save
 * of a blob source reads all of it, so the save can be stopped mid-read.
 */
function held(): { provider: Provider; hold: () => void; release: () => void } {
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;

  function gated(ref: FileRef): Promise<ByteSource> {
    if (!("blob" in ref)) return Promise.reject(new Error(`${ref.name}: not bytes in hand`));
    const source = blobSource(ref.blob);
    return Promise.resolve({
      size: source.size,
      read: async (offset: number, length: number) => {
        await gate;
        return source.read(offset, length);
      },
      close: () => source.close(),
    });
  }

  return {
    provider: {
      name: "held",
      label: "held bytes",
      files: { label: "held bytes", handles: (ref) => "blob" in ref, open: gated },
    },
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      open?.();
      gate = undefined;
    },
  };
}

// A save holds the workspace queue. A list and a peek sent after it are
// answered first. An open sent after it waits behind it.
test("a list and a peek sent while a save is running are answered first", async () => {
  const dir = await folder();
  const bytesInHand = held();
  const w = wire([bytesInHand.provider, paged(1000)]);
  try {
    w.send({ t: "open", id: 1, ref: { name: "held.csv", blob: new Blob([bytes]) } });
    const opened = await w.reply(1);
    if (opened.t !== "opened") throw new Error(`the engine answered an open with ${opened.t}`);
    const source = opened.added.showing;
    // The save's read waits for the index, so the index must finish first.
    await w.when((msg) => msg.t === "progress" && msg.progress.complete);

    bytesInHand.hold();
    w.send({ t: "save", id: 2, place: { source, cells: [], at: "" }, limit: 1 << 20 });
    // The open goes through the queue the save holds. It is the control.
    w.send({ t: "open", id: 3, ref: { name: "sales-q3.csv", path: FIXTURE } });
    w.send({ t: "list", id: 4, path: dir });
    // A peek opens a file through a handler, outside the queue.
    w.send({ t: "peek", id: 5, ref: { name: "sales-q3.csv", path: FIXTURE } });

    const listed = await w.reply(4);
    expect(listed.t).toBe("listed");
    expect((await w.reply(5)).t).toBe("peeked");
    expect(w.seen.map((r) => r.t)).not.toContain("saved");
    expect(w.seen.filter((r) => r.t === "opened")).toHaveLength(1);

    bytesInHand.release();
    expect((await w.reply(2)).t).toBe("saved");
    expect((await w.reply(3)).t).toBe("opened");
  } finally {
    w.close();
  }
});

// ------------------------------------------------------------ through the client

test("the client lists a folder and stats a file in it", async () => {
  const dir = await folder();
  const { engine, done } = connect(undefined, [diskProvider()]);
  try {
    const listing = await engine.list(dir);
    expect(listing.entries.map((e) => e.name)).toEqual(ORDER);

    const entry = await engine.stat(join(dir, "sales-q3.csv"));
    expect(entry.bytes).toBe(bytes.length);
    expect(entry.folder).toBe(false);
  } finally {
    done();
  }
});

test("the client pages a folder with the cursor it was given", async () => {
  const dir = await folder();
  const { engine, done } = connect(undefined, [paged(2)]);
  try {
    const first = await engine.list(dir);
    expect(first.entries.map((e) => e.name)).toEqual(ORDER.slice(0, 2));
    expect(first.next).toBeDefined();

    const second = await engine.list(dir, first.next);
    expect(second.entries.map((e) => e.name)).toEqual(ORDER.slice(2, 4));
  } finally {
    done();
  }
});

test("a refused listing rejects the caller rather than reaching onError", async () => {
  const { engine, done } = connect(undefined, [diskProvider()]);
  try {
    let unwaited: string | undefined;
    engine.onError = (said) => {
      unwaited = english(said);
    };

    await expect(engine.list("s3://acme/exports/")).rejects.toThrow(
      "s3://acme/exports/: nothing here browses it · this build browses local files",
    );
    expect(unwaited).toBeUndefined();
  } finally {
    done();
  }
});

test("an engine with no workspace behind it still browses", async () => {
  const dir = await folder();
  const { engine, done } = connect(undefined, [diskProvider()]);
  try {
    expect((await engine.list(dir)).entries).toHaveLength(ORDER.length);
    // A file from the listing opens by the path the listing gave.
    const entry = (await engine.list(dir)).entries.find((e) => e.name === "sales-q3.csv")!;
    const source = await openOne(engine, { name: entry.name, path: entry.path });
    expect(source.opened.size).toBe(bytes.length);
  } finally {
    done();
  }
});

// ------------------------------------------------------------ peek
//
// A peek opens a file through a handler, reads its front, and closes it. The
// reply is a header and up to twenty rows. peek.test.ts covers the parsing;
// this covers the route: the reply, its id, and refs of bytes in hand.

/** The six columns sales-q3.csv has, and the first row under them. */
const COLUMNS = ["date", "region", "rep", "channel", "units", "revenue"];
const FIRST_ROW = ["2026-07-01", "West", "Ada Okafor", "direct", "1,204", "48160.00"];

test("a peek comes back as a header and the rows under it", async () => {
  const w = wire([diskProvider()]);
  try {
    w.send({ t: "peek", id: 1, ref: { name: "sales-q3.csv", path: FIXTURE } });
    const r = await w.reply(1);

    expect(r.t).toBe("peeked");
    if (r.t !== "peeked") return;
    expect(r.peeked.header).toEqual(COLUMNS);
    expect(r.peeked.rows).toHaveLength(20);
    expect(r.peeked.rows[0]).toEqual(FIRST_ROW);
    // Every row is as wide as the header.
    expect(r.peeked.rows.every((row) => row.length === COLUMNS.length)).toBe(true);
    // The same label an opened source carries.
    expect(english(r.peeked.label)).toBe("UTF-8 · delimiter ','");
  } finally {
    w.close();
  }
});

test("a peek of bytes in hand needs no path", async () => {
  const w = wire([blobProvider()]);
  try {
    w.send({ t: "peek", id: 1, ref: { name: "dropped.csv", blob: new Blob([bytes]) } });
    const r = await w.reply(1);

    expect(r.t).toBe("peeked");
    if (r.t !== "peeked") return;
    expect(r.peeked.header).toEqual(COLUMNS);
    expect(r.peeked.rows[0]).toEqual(FIRST_ROW);
  } finally {
    w.close();
  }
});

test("a peek at a file nothing opens is refused by name, against the id that asked", async () => {
  const w = wire([diskProvider()]);
  try {
    w.send({ t: "peek", id: 7, ref: { name: "q3.csv", path: "s3://acme/exports/q3.csv" } });
    const r = await w.reply(7);

    expect(r).toEqual({
      t: "error",
      id: 7,
      said: {
        t: "text",
        text: "s3://acme/exports/q3.csv: nothing here opens it · this build reads local files",
      },
    });
  } finally {
    w.close();
  }
});

test("the client peeks a file and is handed the header and the rows", async () => {
  const { engine, done } = connect(undefined, [diskProvider()]);
  try {
    const peeked = await engine.peek({ name: "sales-q3.csv", path: FIXTURE });
    expect(peeked.header).toEqual(COLUMNS);
    expect(peeked.rows).toHaveLength(20);
    expect(peeked.rows[0]).toEqual(FIRST_ROW);
  } finally {
    done();
  }
});

test("a peek leaves the workspace holding nothing", async () => {
  const { engine, done } = connect(undefined, [diskProvider()]);
  try {
    await engine.peek({ name: "sales-q3.csv", path: FIXTURE });
    const source = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    // A second source of the same name would be sales-q3_2.
    expect(source.opened.source).toBe("sales-q3");
  } finally {
    done();
  }
});

test("a refused peek rejects the caller rather than reaching onError", async () => {
  const { engine, done } = connect(undefined, [diskProvider()]);
  try {
    let unwaited: string | undefined;
    engine.onError = (said) => {
      unwaited = english(said);
    };

    await expect(engine.peek({ name: "q3.csv", path: "s3://acme/q3.csv" })).rejects.toThrow(
      "s3://acme/q3.csv: nothing here opens it · this build reads local files",
    );
    expect(unwaited).toBeUndefined();
  } finally {
    done();
  }
});
