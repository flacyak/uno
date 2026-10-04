// The engine: one workspace and its log, served to one client over a port.
//
// A platform's entry file builds a Port from its runtime, lists its file
// providers, and calls `serve`.

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
 * Connecting is what a platform gives its engine for signing in to buckets.
 */
export interface Connecting {
  /**
   * Where the connections are kept. They are read once at start and again on
   * each `connections` request.
   */
  connections: Connections;
  /**
   * Returns the sign-in modes, profile names and role trust this engine
   * offers. Present on a platform that connects to buckets.
   */
  signIns?: () => Promise<SignIns>;
  /**
   * Tries a connection before it is saved. Present on a platform that
   * connects to buckets.
   */
  test?: (c: Connection) => Promise<Tried>;
  /**
   * Returns which connection an address is read through, or the uncovered
   * bucket it sits in. A .uno source in an uncovered bucket opens as missing
   * and waits for the bucket to be connected before it reads.
   */
  meet?: (path: string) => Meeting | undefined;
}

/** A reply before its id is set. `serve` adds the id from the request it answers. */
type Unnumbered<R> = R extends { id: number } ? Omit<R, "id"> : never;
type Answer = Unnumbered<Reply>;

/**
 * Handlers maps each request kind to its handler. Every request kind in the
 * protocol needs an entry here, or the type fails. A handler returns
 * undefined for a request the engine answers with silence.
 */
type Handlers = {
  [K in Request["t"]]: (msg: Extract<Request, { t: K }>) => Promise<Answer | undefined>;
};

/** fieldOf returns one field of a message, or undefined for a primitive or a missing field. */
function fieldOf(msg: unknown, key: string): unknown {
  if (typeof msg !== "object" || msg === null || !(key in msg)) return undefined;
  return (msg as Record<string, unknown>)[key];
}

/**
 * requestOf returns the message as a Request if its `t` names a handled
 * kind, or undefined otherwise. Other fields are checked by the handlers.
 */
function requestOf(msg: unknown, handled: Handlers): Request | undefined {
  const t = fieldOf(msg, "t");
  return typeof t === "string" && Object.hasOwn(handled, t) ? (msg as Request) : undefined;
}

/**
 * counted accepts a `value` that is an integer of at least `least`, and
 * throws a Refusal naming `field` for anything else.
 */
function counted(field: string, value: unknown, least: number): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= least) return;
  throw new Refusal({
    t: "text",
    text: `${field} is ${JSON.stringify(value)}, and has to be a whole number of at least ${least}`,
  });
}

/** idOf returns the numeric id of a message, if it has one. */
function idOf(msg: unknown): number | undefined {
  const id = fieldOf(msg, "id");
  return typeof id === "number" ? id : undefined;
}

/** notARequest describes a rejected message by its `t`, or by its type if it has none. */
function notARequest(msg: unknown): Said {
  const named = typeof msg === "object" && msg !== null && "t" in msg;
  const t = fieldOf(msg, "t");
  const kind = !named ? typeof msg : typeof t === "string" ? t : typeof t;
  return { t: "text", text: `not a request this engine answers: ${kind}` };
}

/**
 * serve runs one engine over a port.
 *
 * When `connecting` is absent, requests about connections and sign-ins are
 * refused.
 * `telemetry` receives the time each request took and each source took to
 * index.
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
  // Connections are loaded before the first request is handled, so an open
  // that signs in uses them. A load failure here is ignored; it is reported
  // when a client asks for the connections.
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
    // list, stat, peek, connections and try bypass the workspace queue, so
    // they answer while a save is in progress.
    list: async (m) => ({ t: "listed", listing: await sources.list(m.path, m.cursor) }),
    stat: async (m) => ({ t: "statted", entry: await sources.stat(m.path) }),
    peek: async (m) => ({ t: "peeked", peeked: await peek(sources.files, m.ref) }),
    connections: async () => {
      if (connections === undefined) throw new Refusal({ t: "keeps-no-connections" });
      const read = await connections.load();
      return {
        t: "loaded",
        loaded: { connections: read.connections, failed: read.failed.map(saidOf) },
      };
    },
    signins: async () => {
      if (connecting?.signIns === undefined) throw new Refusal({ t: "offers-no-sign-ins" });
      return { t: "offered", signins: await connecting.signIns() };
    },
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
    // The cast pairs the union msg with the handler for its kind.
    const handler = handlers[msg.t] as (m: Request) => Promise<Answer | undefined>;
    const answer = await handler(msg);
    if (answer !== undefined && "id" in msg) port.post({ ...answer, id: msg.id });
  }

  /** took records how long a request took and whether it was answered or refused. */
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
    // An unknown message is refused with its id and skips the metric, so the
    // metric's request attribute only ever holds known kinds.
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
