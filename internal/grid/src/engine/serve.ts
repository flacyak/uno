// The engine: one workspace and its log, served to one client.
//
// `serve` is what a worker does, minus the worker. A platform's entry file
// builds a Port from whatever its runtime hands it, lists the providers it
// can offer -- a disk, a bucket -- and calls this. Both capabilities a
// workspace needs, opening and browsing, come off that one list. Electron's
// utility process and a browser's Web Worker are each a few lines around the
// same call.

import { ROWS_AT_MOST } from "./protocol.ts";
import type { Port, Reply, Request, SignIns } from "./protocol.ts";
import { Refusal, saidOf } from "../said/index.ts";
import { NO_ROW } from "../sheet/index.ts";
import type { Said } from "../said/index.ts";
import { TUNING } from "./rows.ts";
import type { Tuning } from "./rows.ts";
import { peek } from "./peek.ts";
import type { Sources } from "../plugin/index.ts";
import type { Connection } from "../library/index.ts";
import type { Connections } from "../store/index.ts";
import type { Meeting, Tried } from "../store/s3.ts";
import { MILLISECONDS, REQUEST, unmeasured } from "./telemetry.ts";
import type { Telemetry } from "./telemetry.ts";
import { Workspace } from "./workspace.ts";

/**
 * Connecting is what a platform lets its engine know about signing in, besides
 * the signing itself, which is inside the providers.
 */
export interface Connecting {
  /**
   * Where the platform keeps the connections this engine signs in through.
   * They are read once as it starts and again whenever a client says they
   * changed.
   */
  connections: Connections;
  /**
   * How this engine signs in, for a person connecting a bucket: the modes its
   * platform takes on, with the names of the AWS profiles this machine has
   * where `profile` is one and nothing else about them, and what a role has
   * to trust where `role` is. Absent where the platform connects to nothing.
   */
  signIns?: () => Promise<SignIns>;
  /**
   * Try a connection before it is saved: where its bucket is and a page of its
   * prefix, signed the way it says to sign in. Absent where the platform
   * connects to nothing it could try.
   */
  test?: (c: Connection) => Promise<Tried>;
  /**
   * Which connection an address is read through, or the bucket no connection
   * covers. A .uno's source in such a bucket opens missing and reads nothing
   * until the person connects it, so a workspace somebody sent cannot make
   * uno read a bucket with this machine's credentials, and one that is
   * covered is saved with its connection's id as a hint. The platform
   * supplies it because it is the one that knows how its handlers read an
   * address.
   */
  meet?: (path: string) => Meeting | undefined;
}

/** A reply less its id, which `serve` puts back from the request it answers. */
type Unnumbered<R> = R extends { id: number } ? Omit<R, "id"> : never;
type Answer = Unnumbered<Reply>;

/**
 * Handlers is one answer per kind of request, as a record rather than a
 * switch so that a kind added to the protocol and not here is a type error
 * rather than a request refused at the port. A handler answers with nothing
 * where the request asks for nothing back.
 */
type Handlers = {
  [K in Request["t"]]: (msg: Extract<Request, { t: K }>) => Promise<Answer | undefined>;
};

/** fieldOf is one field of a message off the port, or undefined where the message is not an object or has none. */
function fieldOf(msg: unknown, key: string): unknown {
  if (typeof msg !== "object" || msg === null || !(key in msg)) return undefined;
  return (msg as Record<string, unknown>)[key];
}

/**
 * requestOf is what a message off the port is taken to be, or undefined for
 * one that is not a request at all.
 *
 * The far end of the port is a page, so what arrives is looked at before it
 * is believed: anything that is not an object, or is not of a kind handled,
 * is refused here, before `handle` can throw on it or let it through to no
 * answer. What a request of a known kind holds besides is left to the
 * workspace, which refuses a field it cannot use in the sentence it would
 * refuse a wrong one with.
 */
function requestOf(msg: unknown, handled: Handlers): Request | undefined {
  const t = fieldOf(msg, "t");
  return typeof t === "string" && Object.hasOwn(handled, t) ? (msg as Request) : undefined;
}

/**
 * counted holds a field of a request to a whole number of at least `least`,
 * refusing in words that name the field. A page is at the other end of the
 * port, and "9" + 2000 is "92000".
 */
function counted(field: string, value: unknown, least: number): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= least) return;
  throw new Refusal({
    t: "text",
    text: `${field} is ${JSON.stringify(value)}, and has to be a whole number of at least ${least}`,
  });
}

/** idOf is the id a message carried, where it carried one a reply can be matched by. */
function idOf(msg: unknown): number | undefined {
  const id = fieldOf(msg, "id");
  return typeof id === "number" ? id : undefined;
}

/** notARequest says what a message was instead: its kind where it named one, and its type otherwise. */
function notARequest(msg: unknown): Said {
  const named = typeof msg === "object" && msg !== null && "t" in msg;
  const t = fieldOf(msg, "t");
  const kind = !named ? typeof msg : typeof t === "string" ? t : typeof t;
  return { t: "text", text: `not a request this engine answers: ${kind}` };
}

/**
 * serve runs one engine over a port.
 *
 * An engine given no `connecting` -- a test, a build that connects to nothing
 * -- refuses to answer about connections and sign-ins by name, rather than
 * with an empty list, which would read as a folder or a machine with nothing
 * in it.
 *
 * `telemetry` is told how long each request took to answer and each source
 * took to index. An engine given none measures nothing.
 */
export function serve(
  port: Port<Request, Reply>,
  sources: Sources,
  tuning: Tuning = TUNING,
  connecting?: Connecting,
  telemetry: Telemetry = unmeasured,
): void {
  const connections = connecting?.connections;
  const workspace = new Workspace(sources.files, port, tuning, connecting?.meet, telemetry);
  // Read before anything is answered, so the first request that signs -- a
  // .uno opened the moment the engine is up -- is signed by its connection and
  // not by whatever the machine has. A folder that cannot be read is said when
  // somebody asks for the connections, not to nobody at start.
  const ready = connections?.load().catch(() => undefined);

  const handlers: Handlers = {
    open: async (m) => ({ t: "opened", added: await workspace.open(m.ref) }),
    remove: async (m) => {
      await workspace.remove(m.source);
      return { t: "removed" };
    },
    relink: async (m) => ({ t: "relinked", opened: await workspace.relink(m.source, m.ref) }),
    append: async (m) => ({ t: "appended", opened: await workspace.append(m.source, m.parts) }),
    rows: async (m) => {
      // Both numbers are held to be whole here, where a string would
      // otherwise add itself to a count and read as the whole file.
      counted("first", m.first, 0);
      counted("count", m.count, 0);
      if (m.count > ROWS_AT_MOST) {
        throw new Refusal({
          t: "text",
          text: `a rows request asks for at most ${ROWS_AT_MOST} rows, not ${m.count}`,
        });
      }
      return { t: "rows", first: m.first, ...(await workspace.rows(m.source, m.first, m.count)) };
    },
    edit: async (m) => {
      // A row or column that is not a whole number compares as one and
      // lands in the log as what it is, which the saved file then refuses.
      // NO_ROW is the row a column operation names.
      if (typeof m.edit !== "object" || m.edit === null) {
        throw new Refusal({ t: "text", text: "an edit request carries no edit" });
      }
      counted("row", m.edit.row, NO_ROW);
      counted("col", m.edit.col, 0);
      return { t: "changed", source: m.source, changed: await workspace.edit(m.source, m.edit) };
    },
    undo: async (m) => ({
      t: "changed",
      source: m.source,
      changed: await workspace.undo(m.source),
    }),
    redo: async (m) => ({
      t: "changed",
      source: m.source,
      changed: await workspace.redo(m.source),
    }),
    find: async (m) => ({ t: "found", found: await workspace.find(m.source, m.find) }),
    // list and stat go to sources and never to workspace. Workspace runs
    // everything that touches the log one at a time, and a save of a
    // carried source holds that queue for as long as the bytes take -- a
    // panel scrolling a folder must not wait behind it.
    list: async (m) => ({ t: "listed", listing: await sources.list(m.path, m.cursor) }),
    stat: async (m) => ({ t: "statted", entry: await sources.stat(m.path) }),
    // peek is handed sources.files for the same reason as list and stat
    // above -- it must not queue behind a save. Unlike those two it opens
    // a file of its own to read the front of it, but that file is closed
    // again on the way out and never added to the workspace.
    peek: async (m) => ({ t: "peeked", peeked: await peek(sources.files, m.ref) }),
    // Beside list and stat for the same reason: reading a folder of small
    // files must not wait behind a save.
    connections: async () => {
      if (connections === undefined) throw new Refusal({ t: "keeps-no-connections" });
      const read = await connections.load();
      return {
        t: "loaded",
        loaded: { connections: read.connections, failed: read.failed.map(saidOf) },
      };
    },
    // A person choosing how a connection signs in picks a mode, and a
    // profile by name: names and ARNs are all that crosses. ~/.aws is read
    // in this process, and what is in it besides the names stays here.
    signins: async () => {
      if (connecting?.signIns === undefined) throw new Refusal({ t: "offers-no-sign-ins" });
      return { t: "offered", signins: await connecting.signIns() };
    },
    // Beside list for the same reason: it is a listing, and a save must
    // not hold it up.
    try: async (m) => {
      if (connecting?.test === undefined) throw new Refusal({ t: "tries-no-connection" });
      return { t: "tried", tried: await connecting.test(m.connection) };
    },
    mode: async (m) => {
      workspace.mode(m.transform);
      return undefined;
    },
    save: async (m) => ({ t: "saved", bytes: await workspace.save(m.place, m.limit) }),
    close: async () => {
      await workspace.close();
      return undefined;
    },
  };

  async function handle(msg: Request): Promise<void> {
    await ready;
    // The table is typed by kind, and msg is the union, so the one pairing the
    // compiler cannot see is said here: each handler takes its own kind.
    const handler = handlers[msg.t] as (m: Request) => Promise<Answer | undefined>;
    const answer = await handler(msg);
    if (answer !== undefined && "id" in msg) port.post({ ...answer, id: msg.id });
  }

  /** took says how long a request of one kind took, and whether it was answered or refused. */
  function took(msg: Request, started: number, outcome: "answered" | "refused"): void {
    telemetry({
      name: REQUEST,
      kind: "duration",
      unit: MILLISECONDS,
      value: performance.now() - started,
      attributes: { request: msg.t, outcome },
    });
  }

  port.listen((msg: unknown) => {
    const started = performance.now();
    const request = requestOf(msg, handlers);
    // Refused by whatever id it carried, so nothing waits on it, and not
    // measured: what it called itself is not a kind of request, and a metric
    // must not grow an attribute for every string a page makes up.
    if (request === undefined) {
      port.post({ t: "error", id: idOf(msg), said: notARequest(msg) });
      return;
    }
    handle(request).then(
      () => took(request, started, "answered"),
      (err: unknown) => {
        port.post({ t: "error", id: idOf(request), said: saidOf(err) });
        took(request, started, "refused");
      },
    );
  });
}
