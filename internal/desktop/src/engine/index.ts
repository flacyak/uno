// The engine's entry in Electron: a utility process that owns one file.
//
// The engine itself is `serve` in @uno/grid. This file holds the two facts only
// this runtime knows: the port arrives as a MessagePortMain on parentPort, and
// a file is opened by path through Node.

import { serve } from "@uno/grid/engine";
import type { Reply, Request } from "@uno/grid/engine";
import { nodeSource } from "@uno/grid/store/node";

process.parentPort.once("message", (e) => {
  const port = e.ports[0];
  if (port === undefined) {
    process.exit(1);
    return;
  }

  // The renderer closing its end is how a workspace closes, and this process
  // has nothing else to do.
  port.on("close", () => process.exit(0));

  serve(
    {
      post: (msg: Reply) => port.postMessage(msg),
      listen: (fn: (msg: Request) => void) => {
        port.on("message", (m) => fn(m.data as Request));
        port.start();
      },
      close: () => port.close(),
    },
    (ref) =>
      "path" in ref
        ? nodeSource(ref.path)
        : Promise.reject(new Error(`${ref.name}: the desktop engine opens files by path`)),
  );
});
