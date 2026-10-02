// Reports what the efficiency tests measured, and sends it to a collector.
//
//   node scripts/efficiency.ts [--base <folder>] [--out <file>]
//
// It reads out/efficiency/*.json, which `vp test tests/efficiency` writes, and
// prints a table of every metric. With --base, a folder of the same files from
// the branch a change is going into, the table sets each metric beside what it
// was. With --out the table is written to that file as well.
//
// Where OTEL_EXPORTER_OTLP_ENDPOINT is set the metrics are also sent there as
// the gauge uno.efficiency, one series per metric, labelled with the branch
// they were measured on. That is what a Grafana dashboard plots over time.
// OTEL_EXPORTER_OTLP_HEADERS signs the send in, as it does for any
// OpenTelemetry tool. Where the endpoint is not set nothing is sent, which is
// every run on a machine nobody set up and every pull request from a fork.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { METRICS_PATH, Meter, otlpHeaders } from "../src/engine/telemetry.ts";
import { compare, markdown } from "../tests/efficiency/compare.ts";
import type { Metric } from "../tests/efficiency/record.ts";

const HEAD = fileURLToPath(new URL("../out/efficiency/", import.meta.url));

/** The gauge every metric is sent as. Which metric is a label on it. */
const GAUGE = "uno.efficiency";
/** How long a send may take before it is given up on. */
const SEND_TIMEOUT_MS = 10_000;

function isMetric(v: unknown): v is Metric {
  if (typeof v !== "object" || v === null) return false;
  return (
    "name" in v &&
    typeof v.name === "string" &&
    "unit" in v &&
    typeof v.unit === "string" &&
    "value" in v &&
    typeof v.value === "number"
  );
}

/** metricsIn reads every suite's metrics from a folder, in the order of the file names. */
function metricsIn(folder: string): Metric[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .flatMap((name) => {
      const read: unknown = JSON.parse(readFileSync(join(folder, name), "utf8"));
      if (!Array.isArray(read) || !read.every(isMetric)) {
        throw new Error(`${join(folder, name)} is not a list of metrics`);
      }
      return read;
    });
}

/** send hands the metrics to the collector the environment names, if it names one. */
async function send(metrics: readonly Metric[], env: NodeJS.ProcessEnv): Promise<string> {
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (endpoint === undefined || endpoint === "") {
    return "OTEL_EXPORTER_OTLP_ENDPOINT is not set, so nothing was sent to a collector";
  }

  // A pull request is measured on a branch of its own name. GitHub says which
  // in GITHUB_HEAD_REF, and names the branch a push went to in GITHUB_REF_NAME.
  const branch = env["GITHUB_HEAD_REF"] || env["GITHUB_REF_NAME"] || "local";
  const meter = new Meter({ service: "uno-efficiency" });
  for (const m of metrics) {
    meter.record({
      name: GAUGE,
      kind: "level",
      unit: "",
      value: m.value,
      attributes: { metric: m.name, unit: m.unit, branch },
    });
  }

  const res = await fetch(`${endpoint.replace(/\/+$/, "")}${METRICS_PATH}`, {
    method: "POST",
    headers: {
      ...otlpHeaders(env["OTEL_EXPORTER_OTLP_HEADERS"]),
      "content-type": "application/json",
    },
    body: JSON.stringify(meter.payload()),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`the collector answered ${res.status}: ${await res.text()}`);
  }
  return `sent ${metrics.length} metrics to the collector as ${GAUGE}, branch ${branch}`;
}

const { values } = parseArgs({
  options: { base: { type: "string" }, out: { type: "string" } },
});

const head = metricsIn(HEAD);
if (head.length === 0) {
  throw new Error(`${HEAD} holds no metrics · run \`vp test tests/efficiency\` first`);
}
const base = values.base === undefined ? [] : metricsIn(values.base);

const table = markdown(compare(base, head), base.length > 0);
if (values.out !== undefined) writeFileSync(values.out, table);
console.log(table);
console.log(await send(head, process.env));
