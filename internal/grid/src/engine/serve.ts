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
import type { Sources } from "../plugin/index.ts";
import { Workspace } from "./workspace.ts";

export function serve(port: Port<Request, Reply>, sources: Sources, tuning: Tuning = TUNING): void {
  const workspace = new Workspace(sources.files, port, tuning);

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
      // The route is here and the reading is not. Opening a file through a
      // handler, taking the front of it and working out what it is is a task
      // of its own, and until it lands this says so by name: an empty Peeked
      // would be drawn as a file with no columns in it, which is the quieter
      // lie of the two.
      case "peek": {
        throw new Error(`${msg.ref.name}: this engine cannot peek at a file yet`);
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
