/**
 * @fileoverview The stand-in bucket on a worker thread, as the engine's side
 * sees it: an endpoint, a latency to set, and a close.
 *
 * The bucket runs on a thread of its own so its sending does not wait on the
 * engine's scanning, as a real bucket's would not. It holds one object: the
 * fixture's rows repeated, under one header, built on the worker from the
 * same function the engine's side uses to check rows.
 *
 * The worker runs under plain node, so it is started with type transforms
 * and the alias hooks of paths.js.
 */

import { Worker } from 'node:worker_threads';

import { BUCKET } from '@core-tests/store/standin';

/** The key the object is held under. */
export const KEY = '2025/big.csv';

/** The ref the engine opens the object by. */
export const REF = { name: 'big.csv', path: `s3://${BUCKET}/${KEY}` };

/** What the worker is started with. */
export interface BucketData {
  key: string;
  /** How many times the fixture's rows are repeated. */
  repeats: number;
}

/** A message to the worker. */
export type ToBucket = { t: 'latency'; ms: number } | { t: 'close' };

/** A message from the worker. */
export type FromBucket =
  | { t: 'ready'; endpoint: string }
  | { t: 'latency'; ms: number }
  | { t: 'closed' };

/** FarBucket is the bucket on its worker thread. */
export interface FarBucket {
  endpoint: string;
  /** Sets the milliseconds added before every answer. */
  latency(ms: number): Promise<void>;
  close(): Promise<void>;
}

/** The alias hooks for plain node, at the root of the repository. */
const PATHS = new URL('../../../../paths.js', import.meta.url);
const WORKER = new URL('./bucket.worker.ts', import.meta.url);

/** farBucket starts the bucket on a worker, holding the rows `repeats` times. */
export async function farBucket(repeats: number): Promise<FarBucket> {
  const data: BucketData = { key: KEY, repeats };
  const worker = new Worker(WORKER, {
    workerData: data,
    execArgv: [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      '--import',
      PATHS.href,
    ],
  });

  /** next resolves with the worker's next message of kind `t`. */
  function next<T extends FromBucket['t']>(
    t: T,
  ): Promise<Extract<FromBucket, { t: T }>> {
    return new Promise((resolve, reject) => {
      const heard = (msg: FromBucket): void => {
        if (msg.t !== t) return;
        worker.off('message', heard);
        worker.off('error', reject);
        resolve(msg as Extract<FromBucket, { t: T }>);
      };
      worker.on('message', heard);
      worker.once('error', reject);
    });
  }

  const post = (msg: ToBucket): void => worker.postMessage(msg);
  const { endpoint } = await next('ready');
  return {
    endpoint,
    async latency(ms) {
      const set = next('latency');
      post({ t: 'latency', ms });
      await set;
    },
    async close() {
      const closed = next('closed');
      post({ t: 'close' });
      await closed;
      await worker.terminate();
    },
  };
}
