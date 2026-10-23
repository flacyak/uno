/**
 * @fileoverview An engine over a MessageChannel that reads the disk and a
 * stand-in S3 bucket. Renderer tests use it to open a workspace whose sources
 * are in S3.
 */

import { Engine, messagePort, serve } from "@engine";
import type { MessagePortLike, Reply, Request } from "@engine";
import { sources } from "@plugin";
import { diskProvider } from "@store/node";
import { s3Provider } from "@store/s3";

import { HOME_REGION } from "@grid-tests/store/regions";
import { KEYS } from "@grid-tests/store/standin";
import type { Bucket } from "@grid-tests/store/standin";

export function bucketEngine(b: Bucket): Engine {
  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
    sources([
      diskProvider(),
      s3Provider({
        credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
        endpoint: b.endpoint,
      }),
    ]),
  );
  return new Engine(messagePort<Reply, Request>(port2 as unknown as MessagePortLike));
}
