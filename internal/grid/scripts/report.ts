/**
 * @fileoverview Prints the metrics a suite measured, and sends them to a
 * collector.
 *
 *   node --import ../paths.js scripts/report.ts --kind <kind> [--base <folder>] [--out <file>]
 *
 * The kind is `efficiency` or `performance`. Reads out/<kind>/*.json, written
 * by `vp test tests/<kind>`, and prints a markdown table of every metric.
 * --base names a folder of the same files from another branch; the table
 * then shows each metric beside its value there. --out also writes the table
 * to that file.
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT is set, the metrics are also sent there as
 * the gauge uno.<kind>, one series per metric, labelled with the branch.
 * OTEL_EXPORTER_OTLP_HEADERS is sent with the request.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ENDPOINT_VARIABLE, Meter, collector } from '@engine/telemetry';
import type { Collector } from '@engine/telemetry';
import { compare, markdown } from '@grid-tests/efficiency/compare';
import { KINDS, outFolder } from '@grid-tests/efficiency/record';
import type { Kind, Metric } from '@grid-tests/efficiency/record';
/** How long a send may take before it is abandoned. */
const SEND_TIMEOUT_MS = 10_000;
/** How many times a send is tried when the collector is busy, down, or unreachable. */
const TRIES = 3;
/** The wait before the second try, when the collector names none. It doubles for the third. */
const BACKOFF_MS = 1_000;

function isMetric(v: unknown): v is Metric {
  if (typeof v !== 'object' || v === null) return false;
  return (
    'name' in v &&
    typeof v.name === 'string' &&
    'unit' in v &&
    typeof v.unit === 'string' &&
    'value' in v &&
    typeof v.value === 'number'
  );
}

/** Reads every metrics file in a folder, in file name order. */
function metricsIn(folder: string): Metric[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .toSorted()
    .flatMap((name) => {
      const read: unknown = JSON.parse(
        readFileSync(join(folder, name), 'utf8'),
      );
      if (!Array.isArray(read) || !read.every(isMetric)) {
        throw new Error(`${join(folder, name)} is not a list of metrics`);
      }
      return read;
    });
}

/**
 * Sends the metrics to the collector named in the environment, if any. Each
 * kind is one gauge, uno.<kind>, and the metric's name is a label on it.
 */
async function send(
  kind: Kind,
  metrics: readonly Metric[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const gauge = `uno.${kind}`;
  const to = collector(env);
  if (to === undefined) {
    return `${ENDPOINT_VARIABLE} is not set, so nothing was sent to a collector`;
  }

  // GitHub sets GITHUB_HEAD_REF on a pull request and GITHUB_REF_NAME on a
  // push.
  const branch = env['GITHUB_HEAD_REF'] || env['GITHUB_REF_NAME'] || 'local';
  const meter = new Meter({ service: `uno-${kind}` });
  for (const m of metrics) {
    meter.record({
      name: gauge,
      kind: 'level',
      unit: '',
      value: m.value,
      attributes: { metric: m.name, unit: m.unit, branch },
    });
  }

  const res = await post(to, JSON.stringify(meter.payload()));
  if (!res.ok) {
    throw new Error(
      `the collector answered ${res.status}: ${await res.text()}`,
    );
  }
  return `sent ${metrics.length} metrics to the collector as ${gauge}, branch ${branch}`;
}

/**
 * Posts the payload. A 429 or 5xx reply, or a failed connection, is tried
 * again after a wait: a Grafana tenant has a request rate shared by every
 * sender, and a run that lands in a busy second should not fail for it.
 */
async function post(to: Collector, body: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= TRIES;
    let res: Response;
    try {
      res = await fetch(to.url, {
        method: 'POST',
        headers: { ...to.headers, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      if (!last) {
        await wait(BACKOFF_MS << (attempt - 1));
        continue;
      }
      // fetch keeps the reason it failed in the cause.
      const cause =
        err instanceof Error && err.cause instanceof Error ? err.cause : err;
      throw new Error(
        `the collector could not be reached · ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if ((res.status === 429 || res.status >= 500) && !last) {
      await wait(retryAfterMs(res) ?? BACKOFF_MS << (attempt - 1));
      continue;
    }
    return res;
  }
}

/** The wait a reply asks for in its Retry-After header, when it is in seconds. */
function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isInteger(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const { values } = parseArgs({
  options: {
    kind: { type: 'string' },
    base: { type: 'string' },
    out: { type: 'string' },
  },
});

const kind = KINDS.find((k) => k === values.kind);
if (kind === undefined) {
  throw new Error(`--kind names one of ${KINDS.join(', ')}`);
}
const folder = outFolder(kind);
const head = metricsIn(folder);
if (head.length === 0) {
  throw new Error(
    `${folder} holds no metrics · run \`vp test tests/${kind}\` first`,
  );
}
const base = values.base === undefined ? [] : metricsIn(values.base);

const table = markdown(compare(base, head), base.length > 0, kind);
if (values.out !== undefined) writeFileSync(values.out, table);
console.log(table);

// The table is printed before the send, so a send that fails still leaves the
// report. In GitHub Actions the failure is printed as an error annotation.
try {
  console.log(await send(kind, head, process.env));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `${process.env['GITHUB_ACTIONS'] === 'true' ? '::error::' : ''}${message}`,
  );
  process.exitCode = 1;
}
