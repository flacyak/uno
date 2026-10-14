// An engine over a MessageChannel, for renderer tests that open a workspace
// without a host: over providers of a test's choosing, or over the disk and
// a stand-in S3 bucket.

import { Engine, messagePort, serve } from "@uno/grid/engine";
import type { MessagePortLike, Reply, Request, Tuning } from "@uno/grid/engine";
import { sources } from "@uno/grid/plugin";
import type { Provider } from "@uno/grid/plugin";
import { diskProvider } from "@uno/grid/store/node";
import { s3Provider } from "@uno/grid/store/s3";

import { HOME_REGION } from "../../grid/tests/store/regions.ts";
import { KEYS } from "../../grid/tests/store/standin.ts";
import type { Bucket } from "../../grid/tests/store/standin.ts";

/** engineOver serves an engine reading through `providers` and returns its client. */
export function engineOver(providers: Provider[], tuning?: Tuning): Engine {
  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
    sources(providers),
    tuning,
  );
  return new Engine(messagePort<Reply, Request>(port2 as unknown as MessagePortLike));
}

/** bucketEngine is an engine over the disk and the stand-in bucket `b`. */
export function bucketEngine(b: Bucket): Engine {
  return engineOver([
    diskProvider(),
    s3Provider({
      credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
      endpoint: b.endpoint,
    }),
  ]);
}
