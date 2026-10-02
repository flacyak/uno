/**
 * @fileoverview Sends an engine's measurements to an OTLP collector on a
 * timer, and counts the requests the engine makes to S3.
 *
 * A Meter in engine/telemetry.ts sums the measurements. This file posts the
 * totals every few seconds, one send at a time, and on `flush`. Each platform
 * that runs an engine, the desktop and the server, reads the collector from
 * its environment with `collector` and hands it here with what it calls
 * itself. It is the one way out of the core that is not storage, and
 * tests/store/ways.ts names it beside the S3 and STS handlers.
 *
 * What is counted of S3 is the method, the status class and the bytes
 * answered. The address a request went to stays on the machine.
 */

import { Meter } from '@engine/telemetry';
import type { Collector, Resource, Telemetry } from '@engine/telemetry';

/** Interval between sends. */
export const EXPORT_MS = 10_000;
/** Timeout for one send. */
const SEND_TIMEOUT_MS = 2_000;

/** Metric name: number of S3 requests. */
export const S3_REQUESTS = 'uno.s3.requests';
/** Metric name: bytes received from S3. */
export const S3_RECEIVED = 'uno.s3.received';

/** A running metrics exporter. */
export interface Exporter {
  /** Telemetry hook passed to `serve`. */
  record: Telemetry;
  /** A fetch wrapper that counts S3 requests and bytes. */
  fetch: typeof fetch;
  /** Sends the current totals. Resolves after success and after failure alike. */
  flush(): Promise<void>;
  /** Stops the periodic sends. */
  stop(): void;
}

/** Returns the status class of an HTTP status, such as "2xx". */
function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * The OpenTelemetry resource attribute that tells two processes of one
 * service apart. Grafana files it as the `instance` label.
 */
export const INSTANCE_ATTRIBUTE = 'service.instance.id';

/**
 * exporter starts sending to `to` every EXPORT_MS, filed under `resource`.
 *
 * Each exporter is an instance of its own, named at random unless the
 * resource names it. A total is cumulative since its process began, so two
 * engines sending one series would write over each other's totals: two
 * workspaces open on a desktop, or every engine on a server.
 *
 * `go` is the fetch used for sends to the collector and for the counted S3
 * requests. Defaults to the global fetch.
 */
export function exporter(
  to: Collector,
  resource: Resource,
  go: typeof fetch = fetch,
): Exporter {
  const { url } = to;
  const headers = { ...to.headers, 'content-type': 'application/json' };
  const meter = new Meter({
    ...resource,
    attributes: {
      [INSTANCE_ATTRIBUTE]: crypto.randomUUID(),
      ...resource.attributes,
    },
  });

  async function send(): Promise<void> {
    if (meter.empty) return;
    try {
      await go(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(meter.payload()),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      // Totals are cumulative, so a failed send is covered by the next one.
    }
  }

  // Sends run one at a time, in order. Collectors drop a cumulative total
  // older than the one they already have.
  let sending: Promise<void> = Promise.resolve();
  function flush(): Promise<void> {
    sending = sending.then(send);
    return sending;
  }

  const timer = setInterval(() => void flush(), EXPORT_MS);
  // Lets the process exit while the timer is pending.
  timer.unref();

  return {
    record: meter.record,
    flush,
    stop: () => clearInterval(timer),
    fetch: async (input, init) => {
      const method = init?.method ?? 'GET';
      let outcome = 'failed';
      try {
        const res = await go(input, init);
        outcome = statusClass(res.status);
        // A missing content-length counts as zero bytes.
        const length = Number(res.headers.get('content-length') ?? '0');
        meter.record({
          name: S3_RECEIVED,
          kind: 'count',
          unit: 'By',
          value: length,
        });
        return res;
      } finally {
        meter.record({
          name: S3_REQUESTS,
          kind: 'count',
          unit: '{request}',
          value: 1,
          attributes: { method, outcome },
        });
      }
    },
  };
}
