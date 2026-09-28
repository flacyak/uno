// The engine's entry in Electron: a utility process that owns one file.
//
// The engine itself is `serve` in @uno/grid. This file holds the facts only this
// runtime knows: the port arrives as a MessagePortMain on parentPort, and what
// the process can open -- files on this machine's disks, and objects in S3 read
// the way the connection covering each one says to sign in, or with whatever
// AWS credentials this machine already has where no connection covers it.
//
// There is no blob handler: every file the desktop hands its engine has a
// path, and a Blob that arrives anyway is refused by name.
//
// The credentials are read here, in the engine's own process. The renderer
// asks for an s3:// URL and gets rows back; no key ever crosses into the page.
// So are the connections: main names the folder, and the engine reads it.

import { TUNING, serve } from "@uno/grid/engine";
import type { Reply, Request } from "@uno/grid/engine";
import { sources } from "@uno/grid/plugin";
import { connectionsIn } from "@uno/grid/store";
import { awsProfiles, connectionSigning, diskProvider, nodeStore } from "@uno/grid/store/node";
import { s3Provider } from "@uno/grid/store/s3";

/**
 * Where the connections are kept, as main passed it. An engine started any
 * other way has no folder, and keeps no connections rather than guessing one.
 */
const CONNECTIONS = process.argv
  .find((a) => a.startsWith("--connections="))
  ?.slice("--connections=".length);

process.parentPort.once("message", (e) => {
  const port = e.ports[0];
  if (port === undefined) {
    process.exit(1);
    return;
  }

  // The renderer closing its end is how a workspace closes, and this process
  // has nothing else to do.
  port.on("close", () => process.exit(0));

  // Read through the same disk handler every other file is, from the one
  // folder main named. The S3 provider asks it on every request, so a request
  // is signed by the connection covering where it goes as that connection
  // stands now, and by the machine's own chain where no connection covers it.
  const kept = CONNECTIONS === undefined ? undefined : connectionsIn(nodeStore(), CONNECTIONS);

  serve(
    {
      post: (msg: Reply) => port.postMessage(msg),
      listen: (fn: (msg: Request) => void) => {
        port.on("message", (m) => fn(m.data as Request));
        port.start();
      },
      close: () => port.close(),
    },
    // What this build can reach, written in one place: both the handler list
    // and the lister list come off this same set of providers.
    sources([
      diskProvider(),
      s3Provider({
        credentials: connectionSigning(() => kept?.all ?? []),
        // The same variables the AWS CLI reads, so MinIO or a local stand-in is
        // pointed at the way every other tool on the machine is.
        endpoint: process.env["AWS_ENDPOINT_URL_S3"] ?? process.env["AWS_ENDPOINT_URL"],
      }),
    ]),
    TUNING,
    kept === undefined
      ? undefined
      : {
          connections: kept,
          // Names only: the files are read here, and what else is in them
          // never leaves this process.
          profiles: () => awsProfiles(),
        },
  );
});
