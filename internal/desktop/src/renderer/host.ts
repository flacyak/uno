// Builds the Host the shell uses from the preload Bridge.
//
// Most methods pass straight through. `dropped` throws for a file with no
// path. `connect` asks preload for an engine by id and resolves when a
// MessagePort is posted to the window under that id. `saveConnection` stamps
// and formats the connection, then hands preload the file text.

import { formatConnection, stampConnection } from "@uno/grid/library";

import { m } from "../paraglide/messages.js";
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
    // The error message is built here so it is in the page's language.
    dropped(file) {
      const ref = bridge.dropped(file);
      if (ref === undefined) throw new Error(m.dropped_not_a_file({ name: file.name }));
      return ref;
    },
    pickSave: (suggestedName) => bridge.pickSave(suggestedName),
    save: (path, bytes) => bridge.save(path, bytes),
    quit: () => bridge.quit(),
    // Stamps and formats the connection first. formatConnection throws for a
    // connection holding a key, so that check happens before leaving the page.
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
