// What the engine measures, and how a Meter writes it for a collector.

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
  messagePort,
  otlpHeaders,
  serve,
} from "../../src/engine/index.ts";
import type {
  Measurement,
  MessagePortLike,
  Reply,
  Request,
  SourceHandle,
} from "../../src/engine/index.ts";
import { sources } from "../../src/plugin/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { FIXTURE, bytes, indexed } from "./harness.ts";

/** An engine over a real channel, with everything it measures kept. */
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

/** until waits for the engine to have measured something `found` picks out. */
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

    // A measurement leaves the machine, so it says what was done and not to what.
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

/** A clock that says what it is told to. */
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

  // 3 ms is in the bucket up to 5, 40 in the one up to 50, and a billion in
  // the last, which holds what is over every bound.
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

test("the headers a collector is signed in with are read as every OpenTelemetry tool reads them", () => {
  expect(otlpHeaders(undefined)).toEqual({});
  expect(otlpHeaders("")).toEqual({});
  expect(otlpHeaders("Authorization=Basic%20abc%3D%3D, x-scope = team")).toEqual({
    Authorization: "Basic abc==",
    "x-scope": "team",
  });
});
