// The engine's entry in Electron: a utility process that owns one file.
//
// The engine itself is `serve` in @uno/grid. This file holds the facts only this
// runtime knows: the port arrives as a MessagePortMain on parentPort, and what
// the process can open -- files on this machine's disks, and objects in S3 read
// the way the connection covering each one says to sign in, or with whatever
// AWS credentials this machine already has where no connection covers it, and
// several of either read as one.
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
import { connectionsIn, multiProvider } from "@uno/grid/store";
import {
  awsProfiles,
  connectionAuth,
  connectionSigning,
  diskProvider,
  nodeStore,
} from "@uno/grid/store/node";
import { connectionMeeting, s3Provider, tryConnection } from "@uno/grid/store/s3";

import { exporting } from "./telemetry.ts";

/**
 * Where S3 is: the same variables the AWS CLI reads, so MinIO or a local
 * stand-in is pointed at the way every other tool on the machine is.
 */
const ENDPOINT = process.env["AWS_ENDPOINT_URL_S3"] ?? process.env["AWS_ENDPOINT_URL"];

/**
 * Where the connections are kept, as main passed it. An engine started any
 * other way has no folder, and keeps no connections rather than guessing one.
 */
const CONNECTIONS = process.argv
  .find((a) => a.startsWith("--connections="))
  ?.slice("--connections=".length);

/**
 * This build's version, as main passed it. It is what a collector files the
 * measurements under, so two builds can be told apart on a chart.
 */
const VERSION =
  process.argv.find((a) => a.startsWith("--version="))?.slice("--version=".length) ?? "";

process.parentPort.once("message", (e) => {
  const port = e.ports[0];
  if (port === undefined) {
    process.exit(1);
    return;
  }

  // Where the engine's measurements go, on a machine that names a collector.
  // On every other machine this is undefined and nothing is measured.
  const telemetry = exporting(process.env, VERSION);

  // The renderer closing its end is how a workspace closes, and this process
  // has nothing else to do. What was measured since the last send goes first,
  // and the send is given up on rather than waited for past its timeout.
  port.on("close", () => {
    void (telemetry?.flush() ?? Promise.resolve()).finally(() => process.exit(0));
  });

  // Read through the same disk handler every other file is, from the one
  // folder main named. The S3 provider asks it on every request, so a request
  // is signed by the connection covering where it goes as that connection
  // stands now, and by the machine's own chain where no connection covers it.
  const kept = CONNECTIONS === undefined ? undefined : connectionsIn(nodeStore(), CONNECTIONS);
  // One set of credentials per way of signing in, shared by every request and
  // by a connection being tried, so trying one does not sign in twice.
  const auth = connectionAuth();

  // The places one file can be. Several files read as one are listed over
  // them, so a part is whatever one of these opens, signed as it would be
  // alone.
  const single = [
    diskProvider(),
    s3Provider({
      credentials: connectionSigning(() => kept?.all ?? [], process.env, auth),
      endpoint: ENDPOINT,
      fetch: telemetry?.fetch,
    }),
  ];

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
    sources([...single, multiProvider(single)]),
    TUNING,
    kept === undefined
      ? undefined
      : {
          connections: kept,
          // The desktop signs in as this machine, as one of its profiles, or
          // not at all. Names only: the files are read here, and what else
          // is in them never leaves this process.
          signIns: async () => ({
            modes: ["machine", "profile", "public"],
            profiles: await awsProfiles(),
          }),
          test: (c) => tryConnection(c, { sign: (x) => auth.of(x), endpoint: ENDPOINT }),
          // A .uno somebody sent reads no bucket this machine has not
          // connected, and one this machine has is saved naming it.
          meet: connectionMeeting(() => kept.all),
        },
    telemetry?.record,
  );
});
