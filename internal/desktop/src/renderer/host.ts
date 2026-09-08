// The Host the shell talks to, assembled from what preload could hand over.
//
// Everything but `connect` passes straight through. `connect` asks preload for
// an engine by id and waits for the port to be posted to the window under that
// id, because a port cannot come back through contextBridge as a return value.

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
    saveAs: (suggestedName, bytes) => bridge.saveAs(suggestedName, bytes),
    save: (path, bytes) => bridge.save(path, bytes),
    connect() {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        bridge.connect(id);
      });
    },
  };
}
