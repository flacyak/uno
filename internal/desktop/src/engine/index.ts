// Entry point of the engine utility process in Electron. One process serves
// one workspace.
//
// `serve` from @uno/grid does the work. This file wires it to the runtime:
// the MessagePort arrives on parentPort, and the providers are local disk
// files, S3 objects, and several of either read as one. Every file arrives
// as a path.
//
// AWS credentials and the saved connections are read in this process. The
// renderer only sends s3:// URLs and receives rows.

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

/** S3 endpoint override, read from the same variables the AWS CLI uses. */
const ENDPOINT = process.env["AWS_ENDPOINT_URL_S3"] ?? process.env["AWS_ENDPOINT_URL"];

/**
 * Folder holding the saved connections, passed by main as `--connections=`.
 * Undefined when the flag is absent; the engine then serves files alone.
 */
const CONNECTIONS = process.argv
  .find((a) => a.startsWith("--connections="))
  ?.slice("--connections=".length);

/** App version passed by main as `--version=`. Tags exported telemetry. */
const VERSION =
  process.argv.find((a) => a.startsWith("--version="))?.slice("--version=".length) ?? "";

process.parentPort.once("message", (e) => {
  const port = e.ports[0];
  if (port === undefined) {
    process.exit(1);
    return;
  }

  // Defined when the environment names an OTLP collector.
  const telemetry = exporting(process.env, VERSION);

  // The renderer closes its port to close the workspace. Flush pending
  // telemetry, then exit.
  port.on("close", () => {
    void (telemetry?.flush() ?? Promise.resolve()).finally(() => process.exit(0));
  });

  // Saved connections, read from disk on each request so edits take effect
  // at once.
  const kept = CONNECTIONS === undefined ? undefined : connectionsIn(nodeStore(), CONNECTIONS);
  // Credential cache shared by S3 requests and by `test`.
  const auth = connectionAuth();

  // Providers for a single file. The multi provider below reads each part
  // through one of these.
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
    // Handlers and listers both come from this provider set.
    sources([...single, multiProvider(single)]),
    TUNING,
    kept === undefined
      ? undefined
      : {
          connections: kept,
          // Sign-in modes the connect form offers. Only profile names are
          // returned; the credential files stay in this process.
          signIns: async () => ({
            modes: ["machine", "profile", "public"],
            profiles: await awsProfiles(),
          }),
          test: (c) => tryConnection(c, { sign: (x) => auth.of(x), endpoint: ENDPOINT }),
          // Matches a workspace's sources against saved connections.
          meet: connectionMeeting(() => kept.all),
        },
    telemetry?.record,
  );
});
