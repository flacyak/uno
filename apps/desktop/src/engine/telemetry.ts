/**
 * @fileoverview Sends the engine's metrics to an OTLP collector.
 *
 * @uno/core's exporter sums the measurements and posts them on a timer. This
 * file says where, from the environment, and what the desktop's engine is
 * called. Sending starts when OTEL_EXPORTER_OTLP_ENDPOINT or
 * OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set.
 *
 * The metrics carry request kinds, durations, storage type, and S3 request
 * counts and byte sizes. File names, paths, buckets and keys stay local.
 */

import { collector, messageOf } from "@engine";
import type { Collector } from "@engine";
import { exporter } from "@store/otlp";
import type { Exporter } from "@store/otlp";

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
): Exporter | undefined {
  let to: Collector | undefined;
  try {
    to = collector(env);
  } catch (err) {
    console.error(`uno sends no measurements · ${messageOf(err)}`);
  }
  if (to === undefined) return undefined;
  return exporter(to, { service: "uno-engine", attributes: { "service.version": version } }, go);
}
