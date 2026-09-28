// Where the engine's measurements go: a collector, when this machine names one.
//
// The engine measures and @uno/grid adds it up. This file is the part only a
// platform can do, which is sending it. Nothing is sent unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set, the variable every OpenTelemetry tool
// reads, so it is something a person turns on for their own machine and off
// for everybody else's. Grafana Cloud's OTLP gateway and the local stack in
// observability/ both take what is sent here as it is.
//
// What is sent says what was done and how long it took: the kind of request,
// whether the bytes were on a disk or in a bucket, the count and size of the
// requests made to S3. No file name, path, bucket or key is in it.

import { Meter, collector } from "@uno/grid/engine";
import type { Collector } from "@uno/grid/engine";
import type { Telemetry } from "@uno/grid/engine";

/** How often the totals are sent while the engine runs. */
const EXPORT_MS = 10_000;
/** How long a send may take before it is given up on. Closing waits this long at most. */
const SEND_TIMEOUT_MS = 2_000;

/** How many requests the engine made to S3. */
const S3_REQUESTS = "uno.s3.requests";
/** How many bytes S3 answered with. */
const S3_RECEIVED = "uno.s3.received";

/** Exporting is a collector being told what the engine measures. */
export interface Exporting {
  /** What `serve` is handed. */
  record: Telemetry;
  /** A fetch that counts what goes through it, for the S3 provider. */
  fetch: typeof fetch;
  /** Sends what has been measured so far. It never throws. */
  flush(): Promise<void>;
  /** Stops the sends on a timer. */
  stop(): void;
}

/** What is said of a request by its answer: the hundreds digit of the status. */
function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * exporting reads where to send from `env`, and answers undefined where it
 * names no collector. An endpoint that is set and cannot be read is said
 * once, on stderr, and nothing is measured: a setting somebody got wrong must
 * not stop a file from opening.
 *
 * `go` is how a request goes out, the runtime's own fetch unless said: both
 * the sends to the collector and the requests to S3 that are counted on their
 * way through.
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
      // A collector that is down costs the measurements and nothing else. The
      // totals are running ones, so the next send carries what this one held.
    }
  }

  // One send at a time, in the order asked. Two in flight could arrive out of
  // order, and a collector drops a total older than the one it has. A close
  // during a send on the timer waits for it, then sends what came after.
  let sending: Promise<void> = Promise.resolve();
  function flush(): Promise<void> {
    sending = sending.then(send);
    return sending;
  }

  const timer = setInterval(() => void flush(), EXPORT_MS);
  // The timer alone does not keep the process up.
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
        // S3 says how long every answer is. One that does not counts as no
        // bytes, so what was received is under-counted rather than guessed.
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
