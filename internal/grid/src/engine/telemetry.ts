// What the engine says about how long things took, and how that is written
// for a collector.
//
// The engine measures and does not send. `serve` is handed a Telemetry, which
// is a function, and calls it with each measurement: how long a request took
// to answer, how long a source took to index. Where those go is the
// platform's, as opening a file is. A platform that hands over nothing gets an
// engine that measures nothing.
//
// A measurement names what was done and where the bytes were, and nothing
// about whose they are: no file name, no path, no bucket.
//
// Meter is the usual thing to hand `serve`. It adds measurements up, and
// `payload` writes the totals as an OTLP metrics request in JSON, which is
// what Grafana, and any other OpenTelemetry collector, takes on /v1/metrics.
// It is pure: sending the payload is the platform's too.

/** What is known about a measurement besides its value. */
export type Attributes = Readonly<Record<string, string>>;

/**
 * How measurements of one name add up.
 *
 * A duration is spread over buckets, so a collector can say what the slowest
 * one in a hundred took. A count is added to a running total. A level is a
 * reading, and the newest one stands.
 */
export type Kind = "duration" | "count" | "level";

/** Measurement is one thing the engine, or its platform, measured. */
export interface Measurement {
  /** Dotted, as OpenTelemetry names metrics: "uno.engine.request". */
  name: string;
  kind: Kind;
  /** A UCUM unit, as OpenTelemetry writes them: "ms", "By", "{request}". */
  unit: string;
  value: number;
  attributes?: Attributes;
}

/** Telemetry takes a measurement. It must not throw, and is not waited on. */
export type Telemetry = (m: Measurement) => void;

/** The Telemetry of an engine nobody is measuring. */
export const unmeasured: Telemetry = () => undefined;

/** How long a request took from arriving to its answer being posted. */
export const REQUEST = "uno.engine.request";
/** How long a source took to index, from being opened to its last row counted. */
export const INDEX = "uno.engine.index";
/** How many bytes a source that finished indexing holds. */
export const INDEXED = "uno.engine.indexed";

export const MILLISECONDS = "ms";
export const BYTES = "By";

/**
 * The upper edges of the buckets durations are counted into, in milliseconds:
 * from a row request answered out of the cache to an object indexed over a
 * slow line.
 */
export const DURATION_BOUNDS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000,
];

/** What the collector files a platform's measurements under. */
export interface Resource {
  /** "uno-engine", "uno-efficiency": what is doing the measuring. */
  service: string;
  /** Anything else true of every measurement it sends. */
  attributes?: Attributes;
}

// ------------------------------------------------------------ OTLP, as JSON

interface KeyValue {
  key: string;
  value: { stringValue: string };
}

interface Point {
  attributes: KeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
}

interface NumberPoint extends Point {
  asDouble: number;
}

interface HistogramPoint extends Point {
  count: string;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
}

/** Totals since the meter began, which is the only kind every collector takes. */
const CUMULATIVE = 2;

type Data =
  | { histogram: { dataPoints: HistogramPoint[]; aggregationTemporality: typeof CUMULATIVE } }
  | {
      sum: {
        dataPoints: NumberPoint[];
        aggregationTemporality: typeof CUMULATIVE;
        isMonotonic: true;
      };
    }
  | { gauge: { dataPoints: NumberPoint[] } };

type Metric = { name: string; unit: string } & Data;

/** An OTLP ExportMetricsServiceRequest, as its JSON encoding writes one. */
export interface Payload {
  resourceMetrics: Array<{
    resource: { attributes: KeyValue[] };
    scopeMetrics: Array<{ scope: { name: string }; metrics: Metric[] }>;
  }>;
}

/** What the collector is told wrote the metrics. */
const SCOPE = "@uno/grid";

const NANOS_PER_MS = 1_000_000n;

/** OTLP writes a time as nanoseconds since 1970, in a string: it does not fit a double. */
function nanos(ms: number): string {
  return String(BigInt(Math.round(ms)) * NANOS_PER_MS);
}

function keyValues(attributes: Attributes | undefined): KeyValue[] {
  return Object.entries(attributes ?? {})
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value: { stringValue: value } }));
}

/** What a series has added up to. */
type Total =
  | { kind: "duration"; count: number; sum: number; buckets: number[] }
  | { kind: "count"; sum: number }
  | { kind: "level"; value: number };

interface Series {
  name: string;
  unit: string;
  attributes: KeyValue[];
  total: Total;
}

function begin(kind: Kind): Total {
  switch (kind) {
    case "duration":
      // One more bucket than bounds: the last holds what is over every bound.
      return { kind, count: 0, sum: 0, buckets: DURATION_BOUNDS.map(() => 0).concat(0) };
    case "count":
      return { kind, sum: 0 };
    case "level":
      return { kind, value: 0 };
  }
}

function add(total: Total, value: number): void {
  switch (total.kind) {
    case "duration": {
      const over = DURATION_BOUNDS.findIndex((bound) => value <= bound);
      total.buckets[over === -1 ? DURATION_BOUNDS.length : over]!++;
      total.count++;
      total.sum += value;
      return;
    }
    case "count":
      total.sum += value;
      return;
    case "level":
      total.value = value;
      return;
  }
}

/**
 * Meter adds measurements up and writes the totals for a collector.
 *
 * `now` is the clock, in milliseconds since 1970. It is handed in so the
 * totals of a run can be compared with what they should be.
 */
export class Meter {
  private readonly series = new Map<string, Series>();
  private readonly began: number;
  private readonly resource: Resource;
  private readonly now: () => number;

  constructor(resource: Resource, now: () => number = Date.now) {
    this.resource = resource;
    this.now = now;
    this.began = now();
  }

  /** The Telemetry to hand `serve`. A measurement that is not a number is dropped. */
  readonly record: Telemetry = (m) => {
    if (!Number.isFinite(m.value)) return;
    const attributes = keyValues(m.attributes);
    const key = JSON.stringify([m.name, m.kind, attributes]);
    let series = this.series.get(key);
    if (series === undefined) {
      series = { name: m.name, unit: m.unit, attributes, total: begin(m.kind) };
      this.series.set(key, series);
    }
    add(series.total, m.value);
  };

  /** Whether anything has been measured. A meter with nothing has nothing to send. */
  get empty(): boolean {
    return this.series.size === 0;
  }

  /** payload is every total so far, as one OTLP metrics request. */
  payload(): Payload {
    const point: Point = {
      attributes: [],
      startTimeUnixNano: nanos(this.began),
      timeUnixNano: nanos(this.now()),
    };

    const metrics = new Map<string, Metric>();
    for (const s of this.series.values()) {
      const at = { ...point, attributes: s.attributes };
      const key = JSON.stringify([s.name, s.total.kind]);
      const metric = metrics.get(key) ?? { name: s.name, unit: s.unit, ...empty(s.total.kind) };
      metrics.set(key, metric);

      if ("histogram" in metric && s.total.kind === "duration") {
        metric.histogram.dataPoints.push({
          ...at,
          count: String(s.total.count),
          sum: s.total.sum,
          bucketCounts: s.total.buckets.map(String),
          explicitBounds: [...DURATION_BOUNDS],
        });
      } else if ("sum" in metric && s.total.kind === "count") {
        metric.sum.dataPoints.push({ ...at, asDouble: s.total.sum });
      } else if ("gauge" in metric && s.total.kind === "level") {
        metric.gauge.dataPoints.push({ ...at, asDouble: s.total.value });
      }
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: keyValues({
              ...this.resource.attributes,
              "service.name": this.resource.service,
            }),
          },
          scopeMetrics: [{ scope: { name: SCOPE }, metrics: [...metrics.values()] }],
        },
      ],
    };
  }
}

function empty(kind: Kind): Data {
  switch (kind) {
    case "duration":
      return { histogram: { dataPoints: [], aggregationTemporality: CUMULATIVE } };
    case "count":
      return { sum: { dataPoints: [], aggregationTemporality: CUMULATIVE, isMonotonic: true } };
    case "level":
      return { gauge: { dataPoints: [] } };
  }
}

/** The path a collector takes metrics on, after its OTLP endpoint. */
export const METRICS_PATH = "/v1/metrics";

/**
 * otlpHeaders reads OTEL_EXPORTER_OTLP_HEADERS, which is how every
 * OpenTelemetry tool is told what to sign in with: `key=value` pairs with
 * commas between, the values percent-encoded.
 */
export function otlpHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}
