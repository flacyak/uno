// The Host the shell talks to, assembled from what preload could hand over.
//
// Everything but `connect` and `saveConnection` passes straight through.
// `connect` asks preload for an engine by id and waits for the port to be
// posted to the window under that id, because a port cannot come back through
// contextBridge as a return value. `saveConnection` hands preload the text of
// the file rather than the connection, for a reason Bridge gives.

import { formatConnection, stampConnection } from "@uno/grid/library";

import type { Bridge, Host } from "../shared/host.ts";

export function electronHost(bridge: Bridge): Host {
  let next = 1;
  const waiting = new Map<number, (port: MessagePort) => void>();

  window.addEventListener("message", (e: MessageEvent) => {
    const id = (e.data as { unoEnginePort?: unknown } | null)?.unoEnginePort;
    const port = e.ports[0];
    if (typeof id !== "number" || port === undefined) return;
    waiting.get(id)?.(port);
    waiting.delete(id);
  });

  return {
    open: () => bridge.open(),
    add: () => bridge.add(),
    dropped: (file) => bridge.dropped(file),
    pickSave: (suggestedName) => bridge.pickSave(suggestedName),
    save: (path, bytes) => bridge.save(path, bytes),
    // Stamped and formatted here, so a connection holding a key is refused
    // before it leaves the page; main reads the text back before it writes.
    async saveConnection(c) {
      const stamped = stampConnection(c);
      await bridge.saveConnection(stamped.id, formatConnection(stamped));
      return stamped;
    },
    connect() {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        bridge.connect(id);
      });
    },
  };
}
