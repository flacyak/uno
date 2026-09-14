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
import type { Connections } from "../store/index.ts";
import { Workspace } from "./workspace.ts";

/**
 * serve runs one engine over a port.
 *
 * `connections` is where the platform keeps the connections this engine signs
 * in through. They are read once as it starts and again whenever a client says
 * they changed. An engine given none -- a test, a build that connects to
 * nothing -- refuses the request by name rather than answering with an empty
 * list, which would read as a folder with nothing in it.
 */
export function serve(
  port: Port<Request, Reply>,
  sources: Sources,
  tuning: Tuning = TUNING,
  connections?: Connections,
): void {
  const workspace = new Workspace(sources.files, port, tuning);
  // Started now so the first request that signs finds them read. A folder that
  // cannot be read is said when somebody asks, not to nobody at start.
  void connections?.load().catch(() => undefined);

  async function handle(msg: Request): Promise<void> {
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

  port.listen((msg) => {
    handle(msg).catch((err: unknown) => {
      port.post({ t: "error", id: "id" in msg ? msg.id : undefined, message: messageOf(err) });
    });
  });
}
