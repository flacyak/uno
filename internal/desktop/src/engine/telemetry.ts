// Sends the engine's metrics to an OTLP collector.
//
// @uno/grid's Meter aggregates the measurements. This file posts them on a
// timer. Sending starts when OTEL_EXPORTER_OTLP_ENDPOINT or
// OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set.
//
// The metrics carry request kinds, durations, storage type, and S3 request
// counts and byte sizes. File names, paths, buckets and keys stay local.

import { Meter, collector } from "@uno/grid/engine";
import type { Collector } from "@uno/grid/engine";
import type { Telemetry } from "@uno/grid/engine";

/** Interval between sends. */
const EXPORT_MS = 10_000;
/** Timeout for one send. */
const SEND_TIMEOUT_MS = 2_000;

/** Metric name: number of S3 requests. */
const S3_REQUESTS = "uno.s3.requests";
/** Metric name: bytes received from S3. */
const S3_RECEIVED = "uno.s3.received";

/** A running metrics exporter. */
export interface Exporting {
  /** Telemetry hook passed to `serve`. */
  record: Telemetry;
  /** A fetch wrapper that counts S3 requests and bytes. */
  fetch: typeof fetch;
  /** Sends the current totals. Resolves after success and after failure
   * alike. */
  flush(): Promise<void>;
  /** Stops the periodic sends. */
  stop(): void;
}

/** Returns the status class of an HTTP status, such as "2xx". */
function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Creates an exporter for the collector named in `env`. Returns undefined
 * when `env` omits a collector. An invalid endpoint is logged to stderr
 * once and also returns undefined.
 *
 * `go` is the fetch used for sends to the collector and for the counted S3
 * requests. Defaults to the global fetch.
 */
export function exporting(
  env: Record<string, string | undefined>,
  version: string,
  go: typeof fetch = fetch,
): Exporting | undefined {
  let to: Collector | undefined;
  try {
    to = collector(env);
  } catch (err) {
    console.error(
      `uno sends no measurements · ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (to === undefined) return undefined;

  const { url } = to;
  const headers = { ...to.headers, "content-type": "application/json" };
  const meter = new Meter({ service: "uno-engine", attributes: { "service.version": version } });

  async function send(): Promise<void> {
    if (meter.empty) return;
    try {
      await go(url, {
        method: "POST",
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
      const method = init?.method ?? "GET";
      let outcome = "failed";
      try {
        const res = await go(input, init);
        outcome = statusClass(res.status);
        // A missing content-length counts as zero bytes.
        const length = Number(res.headers.get("content-length") ?? "0");
        meter.record({ name: S3_RECEIVED, kind: "count", unit: "By", value: length });
        return res;
      } finally {
        meter.record({
          name: S3_REQUESTS,
          kind: "count",
          unit: "{request}",
          value: 1,
          attributes: { method, outcome },
        });
      }
    },
  };
}
