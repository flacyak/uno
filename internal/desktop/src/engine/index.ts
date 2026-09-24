// The engine's entry in Electron: a utility process that owns one file.
//
// The engine itself is `serve` in @uno/grid. This file holds the facts only this
// runtime knows: the port arrives as a MessagePortMain on parentPort, and what
// the process can open -- files on this machine's disks, and objects in S3 read
// with whatever AWS credentials this machine already has.
//
// There is no blob handler: every file the desktop hands its engine has a
// path, and a Blob that arrives anyway is refused by name.
//
// The credentials are read here, in the engine's own process. The renderer
// asks for an s3:// URL and gets rows back; no key ever crosses into the page.

import { serve } from "@uno/grid/engine";
import type { Reply, Request } from "@uno/grid/engine";
import { sources } from "@uno/grid/plugin";
import { awsCredentials, diskProvider } from "@uno/grid/store/node";
import { s3Provider } from "@uno/grid/store/s3";

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
    // What this build can reach, written in one place. The handler list is
    // derived from it, and the lister list with it once there are listers to
    // derive -- so browsing arrives here without this file being edited again.
    sources([
      diskProvider(),
      s3Provider({
        credentials: awsCredentials(),
        // The same variables the AWS CLI reads, so MinIO or a local stand-in is
        // pointed at the way every other tool on the machine is.
        endpoint: process.env["AWS_ENDPOINT_URL_S3"] ?? process.env["AWS_ENDPOINT_URL"],
      }),
    ]).files,
  );
});
