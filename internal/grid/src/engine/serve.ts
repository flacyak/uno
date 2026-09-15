// The engine: one file and its log, served to one client.
//
// `serve` is what a worker does, minus the worker. A platform's entry file
// builds a Port from whatever its runtime hands it, says how to open a
// SourceRef, and calls this. Electron's utility process and a browser's Web
// Worker are each a few lines around the same call.

import type { Port, Reply, Request } from "./protocol.ts";
import { messageOf } from "./protocol.ts";
import { TUNING } from "./rows.ts";
import type { Tuning } from "./rows.ts";
import { View } from "./view.ts";
import type { OpenSource } from "./view.ts";

export function serve(
  port: Port<Request, Reply>,
  openSource: OpenSource,
  tuning: Tuning = TUNING,
): void {
  let view: Promise<View> | undefined;

  const need = (): Promise<View> => view ?? Promise.reject(new Error("no file is open"));

  async function handle(msg: Request): Promise<void> {
    switch (msg.t) {
      case "open": {
        if (view !== undefined) throw new Error("this engine already has a file open");
        view = View.open(msg.ref, openSource, port, tuning);
        try {
          port.post({ t: "opened", opened: (await view).opened });
        } catch (err) {
          view = undefined; // a failed open leaves the engine free to try another
          throw err;
        }
        return;
      }
      case "rows": {
        const r = await (await need()).rows(msg.first, msg.count);
        port.post({ t: "rows", id: msg.id, first: msg.first, ...r });
        return;
      }
      case "edit": {
        port.post({ t: "changed", id: msg.id, changed: await (await need()).edit(msg.edit) });
        return;
      }
      case "undo": {
        port.post({ t: "changed", id: msg.id, changed: await (await need()).undo() });
        return;
      }
      case "redo": {
        port.post({ t: "changed", id: msg.id, changed: await (await need()).redo() });
        return;
      }
      case "find": {
        port.post({ t: "found", id: msg.id, found: await (await need()).find(msg.find) });
        return;
      }
      case "mode": {
        (await need()).mode(msg.transform);
        return;
      }
      case "save": {
        const bytes = await (await need()).save(msg.active, msg.limit);
        port.post({ t: "saved", id: msg.id, bytes });
        return;
      }
      case "close": {
        await view?.then(
          (v) => v.close(),
          () => undefined,
        );
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
