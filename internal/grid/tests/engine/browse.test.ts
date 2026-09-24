// Browsing across the protocol: `list` and `stat`.
//
// These are the requests that do not name a source, because they are asked
// before there is one: what is in this folder, how big is that object. They go
// to the listers the engine was wired with and never into the workspace's
// queue, which is the whole point of them -- a panel scrolling a prefix while
// a 30 GB save runs has to keep answering, and a save holds that queue for as
// long as it takes.
//
// Everything here sends raw messages over the channel, because what is under
// test is the protocol itself: which message comes back, with which id, and in
// what order.
//
// The folder every listing here browses is a temp directory with the testdata
// fixtures copied into it. Nothing is symlinked: the sizes checked below are
// the sizes of those copies.

import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { messagePort, serve } from "../../src/engine/index.ts";
import type { MessagePortLike, Reply, Request } from "../../src/engine/index.ts";
import { sources } from "../../src/plugin/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { blobProvider, blobSource } from "../../src/store/index.ts";
import type { ByteSource, FileRef } from "../../src/store/index.ts";
import { diskLister } from "../../src/store/disklister.ts";
import { localFiles } from "../../src/store/node.ts";
import { bytes, FIXTURE } from "./harness.ts";

const TESTDATA = fileURLToPath(new URL("../testdata/", import.meta.url));

/** The fixtures copied into the folder under test, and the folders beside them. */
const FILES = ["sales-q3.csv", "google-ads-sales.csv", "unit-margin.unof"];
const FOLDERS = ["archive", "reports"];

/** Folders first and then by name: the order every listing below expects. */
const ORDER = ["archive", "reports", "google-ads-sales.csv", "sales-q3.csv", "unit-margin.unof"];

/** folder builds the directory every check browses: three fixtures and two folders. */
async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uno-browse-"));
  for (const name of FOLDERS) await mkdir(join(dir, name));
  for (const name of FILES) await copyFile(join(TESTDATA, name), join(dir, name));
  return dir;
}

/**
 * paged is the disk plugged in with a page size of its own, so a folder of
 * five entries is three pages and the cursor has somewhere to go.
 */
function paged(page: number): Provider {
  return { name: "disk", label: "local files", files: localFiles(), browse: diskLister(page) };
}

// ------------------------------------------------------------ the raw channel

/** A client that sends messages and keeps every reply, with no Engine between. */
interface Wire {
  send(req: Request): void;
  /** Every reply, in the order the engine sent them. */
  seen: Reply[];
  /** The reply carrying an id, whenever it lands. */
  reply(id: number): Promise<Reply>;
  /**
   * A reply of a kind that carries no id -- a progress, an offer -- whether it
   * has landed already or not. One that has is still an answer, and a test that
   * only ever watched forward would hang on the fast case.
   */
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
    close: () => {
      client.close();
      port1.close();
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
    // An entry carries what a FileRef carries, so whoever picks one already
    // holds everything an open needs.
    expect(r.listing.entries.map((e) => e.path)).toEqual(ORDER.map((n) => join(dir, n)));
    expect(r.listing.entries.find((e) => e.name === "sales-q3.csv")?.bytes).toBe(bytes.length);
    // Five entries in one page of a thousand: there is no next one.
    expect(r.listing.next).toBeUndefined();
  } finally {
    w.close();
  }
});

// The cursor is the lister's own string and the protocol carries it without
// reading it, so a folder browsed a page at a time comes back as the folder.
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
    // A Date crosses the channel as a Date. It is structured clone and not
    // JSON, and a panel that was handed the string would sort the column wrong.
    expect(r.entry.modified).toBeInstanceOf(Date);
  } finally {
    w.close();
  }
});

// The refusal is the one in claim.ts, and it reaches the client as an error
// against the id that asked, not as a failure nothing was waiting on.
test("a path nothing browses is refused by name, against the id that asked", async () => {
  const w = wire([paged(1000)]);
  try {
    w.send({ t: "list", id: 7, path: "gs://acme/exports/" });
    const r = await w.reply(7);

    expect(r).toEqual({
      t: "error",
      id: 7,
      message: "gs://acme/exports/: nothing here browses it · this build browses local files",
    });
  } finally {
    w.close();
  }
});

// A browser build browses nothing until a connection is added, so this is a
// real engine and not a misconfigured one: it says so rather than answering
// with an empty folder.
test("an engine whose providers cannot browse refuses to browse at all", async () => {
  const w = wire([blobProvider()]);
  try {
    w.send({ t: "stat", id: 1, path: "/home/jo/q3.csv" });
    const r = await w.reply(1);

    expect(r).toMatchObject({
      t: "error",
      id: 1,
      message: "/home/jo/q3.csv: nothing here browses it · this build browses nothing",
    });
  } finally {
    w.close();
  }
});

// ------------------------------------------------------------ outside the queue

/**
 * held is a provider whose reads can be stopped mid-flight, so a save can be
 * caught in the middle of one.
 *
 * It opens bytes in hand rather than a file, which is what makes the save read
 * them at all: a source with a path is written into a .uno as that path and
 * never read again, and one without has to be carried.
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

// The proof this task exists for. A save holds the workspace's queue for as
// long as the bytes take, and browsing must not wait behind it: the open sent
// after the save is still waiting when the listing has already come back.
test("a list sent while a save is running is answered before the save finishes", async () => {
  const dir = await folder();
  const bytesInHand = held();
  const w = wire([bytesInHand.provider, paged(1000)]);
  try {
    w.send({ t: "open", id: 1, ref: { name: "held.csv", blob: new Blob([bytes]) } });
    const opened = await w.reply(1);
    if (opened.t !== "opened") throw new Error(`the engine answered an open with ${opened.t}`);
    const source = opened.added.showing;
    // A carried source is saved by reading the whole of it, and that read waits
    // for the index, so the index has to be done before the gate means anything.
    await w.when((msg) => msg.t === "progress" && msg.progress.complete);

    bytesInHand.hold();
    w.send({ t: "save", id: 2, place: { source, cells: [], at: "" }, limit: 1 << 20 });
    // An open goes through the same queue the save is holding, so it is the
    // control: whatever is true of the listing must not be true of this.
    w.send({ t: "open", id: 3, ref: { name: "sales-q3.csv", path: FIXTURE } });
    w.send({ t: "list", id: 4, path: dir });

    const listed = await w.reply(4);
    expect(listed.t).toBe("listed");
    expect(w.seen.map((r) => r.t)).not.toContain("saved");
    expect(w.seen.filter((r) => r.t === "opened")).toHaveLength(1);

    bytesInHand.release();
    expect((await w.reply(2)).t).toBe("saved");
    expect((await w.reply(3)).t).toBe("opened");
  } finally {
    w.close();
  }
});
