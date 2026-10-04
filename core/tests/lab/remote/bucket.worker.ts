/**
 * @fileoverview The worker side of far.ts: the stand-in bucket from
 * tests/store/standin.ts, holding one object, with its latency set by
 * message.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { HOME_REGION } from '@core-tests/store/regions';
import { bucket } from '@core-tests/store/standin';
import { repeated } from '@core-tests/testdata/sales-q3';
import type { BucketData, FromBucket, ToBucket } from './far.ts';

const port = parentPort!;
const data = workerData as BucketData;
const b = await bucket(
  undefined,
  HOME_REGION,
  new Map([[data.key, repeated(data.repeats)]]),
);

const tell = (msg: FromBucket): void => port.postMessage(msg);

port.on('message', (msg: ToBucket) => {
  switch (msg.t) {
    case 'latency':
      b.latency = msg.ms;
      tell({ t: 'latency', ms: msg.ms });
      return;
    case 'close':
      void b.close().then(() => tell({ t: 'closed' }));
      return;
    default:
      throw new Error(`not a message the bucket answers: ${String(msg)}`);
  }
});

tell({ t: 'ready', endpoint: b.endpoint });
