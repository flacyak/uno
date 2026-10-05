// The engine: one workspace and its log, served to one client.
//
// `serve` is what a worker does, minus the worker. A platform's entry file
// builds a Port from whatever its runtime hands it, lists the providers it
// can offer -- a disk, a bucket -- and calls this. Both capabilities a
// workspace needs, opening and browsing, come off that one list. Electron's
// utility process and a browser's Web Worker are each a few lines around the
// same call.

import type { Port, Reply, Request } from "./protocol.ts";
import { messageOf } from "./protocol.ts";
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
   * The names of the AWS profiles this machine has, for a person choosing one,
   * and nothing else about them. Absent where there is no ~/.aws to read: the
   * hosted engine signs in with roles.
   */
  profiles?: () => Promise<string[]>;
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

/**
 * serve runs one engine over a port.
 *
 * An engine given no `connecting` -- a test, a build that connects to nothing
 * -- refuses to answer about connections and profiles by name, rather than
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

  async function handle(msg: Request): Promise<void> {
    await ready;
    switch (msg.t) {
      case "open": {
        port.post({ t: "opened", id: msg.id, added: await workspace.open(msg.ref) });
        return;
      }
      case "remove": {
        await workspace.remove(msg.source);
        port.post({ t: "removed", id: msg.id });
        return;
      }
      case "relink": {
        const opened = await workspace.relink(msg.source, msg.ref);
        port.post({ t: "relinked", id: msg.id, opened });
        return;
      }
      case "append": {
        const opened = await workspace.append(msg.source, msg.parts);
        port.post({ t: "appended", id: msg.id, opened });
        return;
      }
      case "rows": {
        const r = await workspace.rows(msg.source, msg.first, msg.count);
        port.post({ t: "rows", id: msg.id, first: msg.first, ...r });
        return;
      }
      case "edit": {
        const changed = await workspace.edit(msg.source, msg.edit);
        port.post({ t: "changed", id: msg.id, source: msg.source, changed });
        return;
      }
      case "undo": {
        const changed = await workspace.undo(msg.source);
        port.post({ t: "changed", id: msg.id, source: msg.source, changed });
        return;
      }
      case "redo": {
        const changed = await workspace.redo(msg.source);
        port.post({ t: "changed", id: msg.id, source: msg.source, changed });
        return;
      }
      case "find": {
        port.post({ t: "found", id: msg.id, found: await workspace.find(msg.source, msg.find) });
        return;
      }
      // list and stat go to sources and never to workspace. Workspace runs
      // everything that touches the log one at a time, and a save of a
      // carried source holds that queue for as long as the bytes take -- a
      // panel scrolling a folder must not wait behind it.
      case "list": {
        port.post({ t: "listed", id: msg.id, listing: await sources.list(msg.path, msg.cursor) });
        return;
      }
      case "stat": {
        port.post({ t: "statted", id: msg.id, entry: await sources.stat(msg.path) });
        return;
      }
      // peek is handed sources.files for the same reason as list and stat
      // above -- it must not queue behind a save. Unlike those two it opens
      // a file of its own to read the front of it, but that file is closed
      // again on the way out and never added to the workspace.
      case "peek": {
        port.post({ t: "peeked", id: msg.id, peeked: await peek(sources.files, msg.ref) });
        return;
      }
      // Beside list and stat for the same reason: reading a folder of small
      // files must not wait behind a save.
      case "connections": {
        if (connections === undefined) {
          throw new Error(
            "this engine keeps no connections · its platform gave it nowhere to read them from",
          );
        }
        const read = await connections.load();
        port.post({
          t: "loaded",
          id: msg.id,
          loaded: { connections: read.connections, failed: read.failed.map((e) => e.message) },
        });
        return;
      }
      // A person choosing how a connection signs in picks a profile by name,
      // and a name is all that crosses: ~/.aws is read in this process, and
      // what is in it besides the names stays here.
      case "profiles": {
        if (connecting?.profiles === undefined) {
          throw new Error(
            "this engine has no AWS profiles to offer · its platform signs in another way",
          );
        }
        port.post({ t: "names", id: msg.id, names: await connecting.profiles() });
        return;
      }
      // Beside list for the same reason: it is a listing, and a save must
      // not hold it up.
      case "try": {
        if (connecting?.test === undefined) {
          throw new Error("this engine cannot try a connection · its platform connects to nothing");
        }
        port.post({ t: "tried", id: msg.id, tried: await connecting.test(msg.connection) });
        return;
      }
      case "mode": {
        workspace.mode(msg.transform);
        return;
      }
      case "save": {
        const bytes = await workspace.save(msg.place, msg.limit);
        port.post({ t: "saved", id: msg.id, bytes });
        return;
      }
      case "close": {
        await workspace.close();
        return;
      }
    }
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

  port.listen((msg) => {
    const started = performance.now();
    handle(msg).then(
      () => took(msg, started, "answered"),
      (err: unknown) => {
        port.post({ t: "error", id: "id" in msg ? msg.id : undefined, message: messageOf(err) });
        took(msg, started, "refused");
      },
    );
  });
}
