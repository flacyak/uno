// What the engine measures, how a Meter writes it as OTLP JSON, and how a
// collector's address is read from the environment.

import { expect, test } from "vite-plus/test";

import {
  BYTES,
  DURATION_BOUNDS,
  Engine,
  INDEX,
  INDEXED,
  MILLISECONDS,
  Meter,
  REQUEST,
  collector,
  messagePort,
  otlpHeaders,
  serve,
} from "../../src/engine/index.ts";
import type {
  Measurement,
  MessagePortLike,
  Payload,
  Reply,
  Request,
  SourceHandle,
} from "../../src/engine/index.ts";
import { sources } from "../../src/plugin/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { FIXTURE, bytes, indexed } from "./harness.ts";

/** An engine over a real channel, with every measurement kept in `seen`. */
function measured(): { engine: Engine; seen: Measurement[] } {
  const seen: Measurement[] = [];
  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
    sources([diskProvider()]),
    undefined,
    undefined,
    (m) => seen.push(m),
  );
  return {
    engine: new Engine(messagePort<Reply, Request>(port2 as unknown as MessagePortLike)),
    seen,
  };
}

/** until waits for a measurement `found` picks out. */
async function until(
  seen: Measurement[],
  found: (m: Measurement) => boolean,
): Promise<Measurement> {
  for (;;) {
    const m = seen.find(found);
    if (m !== undefined) return m;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("an engine says how long each request and each index took, and nothing about the file", async () => {
  const { engine, seen } = measured();
  try {
    const { sources: opened } = await engine.open({ name: "sales-q3.csv", path: FIXTURE });
    const src: SourceHandle = opened[0]!;
    await indexed(src);
    await src.rows(0, 10);

    const open = await until(
      seen,
      (m) => m.name === REQUEST && m.attributes?.["request"] === "open",
    );
    expect(open).toMatchObject({ kind: "duration", unit: MILLISECONDS });
    expect(open.attributes).toEqual({ request: "open", outcome: "answered" });
    expect(open.value).toBeGreaterThan(0);

    const rows = await until(seen, (m) => m.attributes?.["request"] === "rows");
    expect(rows.attributes).toEqual({ request: "rows", outcome: "answered" });

    const index = await until(seen, (m) => m.name === INDEX);
    expect(index).toMatchObject({
      kind: "duration",
      unit: MILLISECONDS,
      attributes: { place: "disk" },
    });
    const size = await until(seen, (m) => m.name === INDEXED);
    expect(size).toMatchObject({ kind: "count", unit: BYTES, value: bytes.length });
    expect(seen.filter((m) => m.name === INDEX).length, "an index finishes once").toBe(1);

    // Every measurement keeps the file's name out.
    const said = JSON.stringify(seen);
    expect(said).not.toContain("sales-q3");
    expect(said).not.toContain(FIXTURE);
  } finally {
    engine.close();
  }
});

test("a request the engine refuses is measured as refused", async () => {
  const { engine, seen } = measured();
  try {
    await expect(engine.open({ name: "gone.csv", path: `${FIXTURE}.gone` })).rejects.toThrow();
    const open = await until(seen, (m) => m.name === REQUEST);
    expect(open.attributes).toEqual({ request: "open", outcome: "refused" });
  } finally {
    engine.close();
  }
});

/** Fixed clock values. */
const BEGAN = 1_700_000_000_000;
const LATER = BEGAN + 10_000;

test("a meter adds measurements up into one OTLP request", () => {
  let now = BEGAN;
  const meter = new Meter(
    { service: "uno-engine", attributes: { "service.version": "1.2.3" } },
    () => now,
  );
  expect(meter.empty).toBe(true);

  const rows = { request: "rows", outcome: "answered" };
  meter.record({ name: REQUEST, kind: "duration", unit: MILLISECONDS, value: 3, attributes: rows });
  meter.record({
    name: REQUEST,
    kind: "duration",
    unit: MILLISECONDS,
    value: 40,
    attributes: rows,
  });
  meter.record({
    name: REQUEST,
    kind: "duration",
    unit: MILLISECONDS,
    value: 1e9,
    attributes: rows,
  });
  meter.record({ name: INDEXED, kind: "count", unit: BYTES, value: 100 });
  meter.record({ name: INDEXED, kind: "count", unit: BYTES, value: 50 });
  meter.record({ name: "uno.level", kind: "level", unit: "1", value: 7 });
  meter.record({ name: "uno.level", kind: "level", unit: "1", value: 9 });
  meter.record({ name: "uno.level", kind: "level", unit: "1", value: Number.NaN });
  expect(meter.empty).toBe(false);
  now = LATER;

  const payload = meter.payload();
  const resource = payload.resourceMetrics[0]!;
  expect(resource.resource.attributes).toEqual([
    { key: "service.name", value: { stringValue: "uno-engine" } },
    { key: "service.version", value: { stringValue: "1.2.3" } },
  ]);

  const [request, indexed, level] = resource.scopeMetrics[0]!.metrics;
  const times = { startTimeUnixNano: `${BEGAN}000000`, timeUnixNano: `${LATER}000000` };

  // 3 ms falls in the bucket up to 5, 40 in the one up to 50, and 1e9 in the
  // overflow bucket.
  const buckets = DURATION_BOUNDS.map(() => "0").concat("0");
  buckets[DURATION_BOUNDS.indexOf(5)] = "1";
  buckets[DURATION_BOUNDS.indexOf(50)] = "1";
  buckets[DURATION_BOUNDS.length] = "1";
  expect(request).toEqual({
    name: REQUEST,
    unit: MILLISECONDS,
    histogram: {
      aggregationTemporality: 2,
      dataPoints: [
        {
          ...times,
          attributes: [
            { key: "outcome", value: { stringValue: "answered" } },
            { key: "request", value: { stringValue: "rows" } },
          ],
          count: "3",
          sum: 1e9 + 43,
          bucketCounts: buckets,
          explicitBounds: [...DURATION_BOUNDS],
        },
      ],
    },
  });
  expect(indexed).toEqual({
    name: INDEXED,
    unit: BYTES,
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [{ ...times, attributes: [], asDouble: 150 }],
    },
  });
  expect(level).toEqual({
    name: "uno.level",
    unit: "1",
    gauge: { dataPoints: [{ ...times, attributes: [], asDouble: 9 }] },
  });
});

test("the JSON a collector reads has every 64-bit integer in a string and every double as a number", () => {
  const meter = new Meter({ service: "uno-engine" }, () => BEGAN);
  meter.record({
    name: REQUEST,
    kind: "duration",
    unit: MILLISECONDS,
    value: 3,
    attributes: { request: "rows", outcome: "answered" },
  });
  meter.record({
    name: INDEXED,
    kind: "count",
    unit: BYTES,
    value: 100,
    attributes: { place: "disk" },
  });

  // The JSON text is what is checked.
  const sent = JSON.parse(JSON.stringify(meter.payload())) as Payload;
  const [histogram, sum] = sent.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
  if (!("histogram" in histogram!) || !("sum" in sum!))
    throw new Error("the metrics are not in the order they were recorded");

  expect(histogram.histogram.aggregationTemporality).toBe(2);
  expect(sum.sum.aggregationTemporality).toBe(2);
  expect(sum.sum.isMonotonic).toBe(true);

  const bucket = histogram.histogram.dataPoints[0]!;
  expect(typeof bucket.startTimeUnixNano).toBe("string");
  expect(typeof bucket.timeUnixNano).toBe("string");
  expect(bucket.timeUnixNano).toMatch(/^[0-9]+$/);
  expect(typeof bucket.count).toBe("string");
  expect(typeof bucket.sum).toBe("number");
  for (const n of bucket.bucketCounts) expect(typeof n).toBe("string");
  for (const b of bucket.explicitBounds) expect(typeof b).toBe("number");
  expect(bucket.bucketCounts.length).toBe(bucket.explicitBounds.length + 1);
  expect(bucket.attributes).toEqual([
    { key: "outcome", value: { stringValue: "answered" } },
    { key: "request", value: { stringValue: "rows" } },
  ]);

  const total = sum.sum.dataPoints[0]!;
  expect(typeof total.asDouble).toBe("number");
  expect("asInt" in total).toBe(false);
  expect(total.attributes).toEqual([{ key: "place", value: { stringValue: "disk" } }]);
  expect(sent.resourceMetrics[0]!.resource.attributes).toEqual([
    { key: "service.name", value: { stringValue: "uno-engine" } },
  ]);
  expect(sent.resourceMetrics[0]!.scopeMetrics[0]!.scope).toEqual({ name: "@uno/grid" });
});

test("the headers a collector is signed in with are read as every OpenTelemetry tool reads them", () => {
  expect(otlpHeaders(undefined)).toEqual({});
  expect(otlpHeaders("")).toEqual({});
  expect(otlpHeaders("Authorization=Basic%20abc%3D%3D, x-scope = team")).toEqual({
    Authorization: "Basic abc==",
    "x-scope": "team",
  });
});

const GATEWAY = "https://otlp-gateway-prod-us-east-0.grafana.net/otlp";
const SIGNED = "Authorization=Basic%20abc";
const READ = {
  url: `${GATEWAY}/v1/metrics`,
  headers: { Authorization: "Basic abc" },
};

test("an environment that names no collector sends nowhere", () => {
  expect(collector({})).toBeUndefined();
  expect(collector({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " })).toBeUndefined();
});

// The value may be pasted with quotes, a trailing slash, a line break, or as
// the whole NAME="value" line.
test.each([
  ["as it is", GATEWAY, SIGNED],
  ["with a slash after it", `${GATEWAY}/`, SIGNED],
  ["in the quotes it was shown in", `"${GATEWAY}"`, `"${SIGNED}"`],
  ["in single quotes", `'${GATEWAY}'`, `'${SIGNED}'`],
  [
    "as the whole line",
    `OTEL_EXPORTER_OTLP_ENDPOINT="${GATEWAY}"`,
    `OTEL_EXPORTER_OTLP_HEADERS="${SIGNED}"`,
  ],
  ["with a line break after it", `${GATEWAY}\n`, ` ${SIGNED}\n`],
])("a collector's address is read %s", (_, endpoint, headers) => {
  expect(
    collector({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_HEADERS: headers }),
  ).toEqual(READ);
});

// The metrics-specific endpoint is used exactly as given, and takes precedence
// over the general one. So do the metrics headers.
test("an address for metrics alone is taken as it is, over the one for every signal", () => {
  const METRICS = `${GATEWAY}/metrics-here`;
  expect(
    collector({
      OTEL_EXPORTER_OTLP_ENDPOINT: GATEWAY,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${METRICS}/`,
      OTEL_EXPORTER_OTLP_HEADERS: SIGNED,
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-scope=team",
    }),
  ).toEqual({ url: `${METRICS}/`, headers: { "x-scope": "team" } });
  expect(collector({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: METRICS })).toEqual({
    url: METRICS,
    headers: {},
  });
  expect(() => collector({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "4318" })).toThrow(
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is not a URL · it does not start with https://, and is 4 characters long",
  );
});

// http/json, http/protobuf and unset are accepted. grpc is refused.
test("a protocol that is not OTLP over HTTP is refused by name", () => {
  for (const protocol of ["http/json", "http/protobuf", ""]) {
    expect(
      collector({ OTEL_EXPORTER_OTLP_ENDPOINT: GATEWAY, OTEL_EXPORTER_OTLP_PROTOCOL: protocol }),
    ).toEqual({ ...READ, headers: {} });
  }
  expect(() =>
    collector({ OTEL_EXPORTER_OTLP_ENDPOINT: GATEWAY, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }),
  ).toThrow(
    "OTEL_EXPORTER_OTLP_PROTOCOL is grpc, and metrics are sent as OTLP over HTTP · set it to http/json or leave it unset",
  );
  expect(() =>
    collector({
      OTEL_EXPORTER_OTLP_ENDPOINT: GATEWAY,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc",
    }),
  ).toThrow("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL is grpc");
});

test("an endpoint that is not a URL is refused by name, saying what is wrong and not what it holds", () => {
  const TOKEN = "glc_secret";
  const refused = (endpoint: string): string => {
    try {
      collector({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_HEADERS: SIGNED });
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error(`${endpoint} was read as a URL`);
  };

  expect(refused(`Authorization=Basic%20${TOKEN}`)).toBe(
    "OTEL_EXPORTER_OTLP_ENDPOINT is not a URL · it holds what OTEL_EXPORTER_OTLP_HEADERS should, so the two look swapped",
  );
  const BARE = `otlp-gateway-${TOKEN}.grafana.net/otlp`;
  expect(refused(BARE)).toBe(
    `OTEL_EXPORTER_OTLP_ENDPOINT is not a URL · it does not start with https://, and is ${BARE.length} characters long`,
  );
  const SPACED = `https://${TOKEN} gateway/otlp`;
  expect(refused(SPACED)).toBe(
    `OTEL_EXPORTER_OTLP_ENDPOINT is not a URL · it starts as a URL does and cannot be read as one, and is ${SPACED.length} characters long`,
  );
});

test("headers that are set and hold no header are refused by name", () => {
  expect(() =>
    collector({ OTEL_EXPORTER_OTLP_ENDPOINT: GATEWAY, OTEL_EXPORTER_OTLP_HEADERS: "glc_secret" }),
  ).toThrow(
    "OTEL_EXPORTER_OTLP_HEADERS holds no header · it is read as key=value pairs with commas between",
  );
  expect(collector({ OTEL_EXPORTER_OTLP_ENDPOINT: GATEWAY })).toEqual({ ...READ, headers: {} });
});
