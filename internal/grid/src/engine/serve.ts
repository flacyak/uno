// The engine: one workspace and its log, served to one client.
//
// `serve` is what a worker does, minus the worker. A platform's entry file
// builds a Port from whatever its runtime hands it, says how to open a
// SourceRef, and calls this. Electron's utility process and a browser's Web
// Worker are each a few lines around the same call.

import type { Port, Reply, Request } from "./protocol.ts";
import { messageOf } from "./protocol.ts";
import { TUNING } from "./rows.ts";
import type { Tuning } from "./rows.ts";
import type { OpenSource } from "./view.ts";
import { Workspace } from "./workspace.ts";

export function serve(
  port: Port<Request, Reply>,
  openSource: OpenSource,
  tuning: Tuning = TUNING,
): void {
  const workspace = new Workspace(openSource, port, tuning);

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
