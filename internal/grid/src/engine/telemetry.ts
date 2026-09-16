// Engine timing measurements, and how they are written for an OTLP collector.
//
// `serve` calls a Telemetry function with each measurement: how long a
// request took, how long a source took to index. Sending is left to the
// platform. A measurement carries timings and request kinds only, so file
// names, paths and buckets stay on the machine.
//
// Meter sums measurements, and `payload` writes the totals as an OTLP
// metrics request in JSON for a collector's /v1/metrics endpoint.

/** String attributes attached to a measurement. */
export type Attributes = Readonly<Record<string, string>>;

/**
 * How measurements of one name are summed. A duration is counted into
 * histogram buckets. A count is added to a running total. A level keeps the
 * newest value.
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

/** Telemetry takes a measurement. It returns at once and swallows its own failures. */
export type Telemetry = (m: Measurement) => void;

/** A Telemetry that discards every measurement. */
export const unmeasured: Telemetry = () => undefined;

/** How long a request took from arriving to its reply being posted. */
export const REQUEST = "uno.engine.request";
/** How long a source took to index, from open to the last row counted. */
export const INDEX = "uno.engine.index";
/** How many bytes a source that finished indexing holds. */
export const INDEXED = "uno.engine.indexed";

export const MILLISECONDS = "ms";
export const BYTES = "By";

/** The upper bounds of the duration histogram buckets, in milliseconds. */
export const DURATION_BOUNDS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000,
];

/** The OTLP resource a platform's measurements are filed under. */
export interface Resource {
  /** The service name: "uno-engine", "uno-efficiency". */
  service: string;
  /** Attributes shared by every measurement sent. */
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

/** OTLP aggregation temporality for totals since the meter began. */
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

/** An OTLP ExportMetricsServiceRequest in its JSON encoding. */
export interface Payload {
  resourceMetrics: Array<{
    resource: { attributes: KeyValue[] };
    scopeMetrics: Array<{ scope: { name: string }; metrics: Metric[] }>;
  }>;
}

/** The OTLP instrumentation scope name. */
const SCOPE = "@uno/grid";

const NANOS_PER_MS = 1_000_000n;

/** Formats a time as nanoseconds since 1970 in a string, as OTLP requires. */
function nanos(ms: number): string {
  return String(BigInt(Math.round(ms)) * NANOS_PER_MS);
}

function keyValues(attributes: Attributes | undefined): KeyValue[] {
  return Object.entries(attributes ?? {})
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value: { stringValue: value } }));
}

/** The running total of one series. */
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
      // One more bucket than bounds. The last holds values over every bound.
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
 * Meter sums measurements and writes the totals as an OTLP payload.
 *
 * `now` is the clock in milliseconds since 1970. It is injectable for tests.
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

  /** The Telemetry to hand `serve`. A measurement with a non-finite value is dropped. */
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

  /** Whether the meter is still empty. */
  get empty(): boolean {
    return this.series.size === 0;
  }

  /** payload returns every total so far as one OTLP metrics request. */
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

/** The path appended to a general OTLP endpoint for metrics. */
export const METRICS_PATH = "/v1/metrics";

/** The standard OpenTelemetry variable for the collector endpoint. */
export const ENDPOINT_VARIABLE = "OTEL_EXPORTER_OTLP_ENDPOINT";
/** The standard OpenTelemetry variable for request headers. */
export const HEADERS_VARIABLE = "OTEL_EXPORTER_OTLP_HEADERS";
/** The standard OpenTelemetry variable for the wire protocol. */
export const PROTOCOL_VARIABLE = "OTEL_EXPORTER_OTLP_PROTOCOL";

/**
 * The metrics-specific variables. Each overrides its general one when set.
 * The metrics endpoint is used as-is, as the full URL of the collector.
 */
export const METRICS_ENDPOINT_VARIABLE = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";
export const METRICS_HEADERS_VARIABLE = "OTEL_EXPORTER_OTLP_METRICS_HEADERS";
export const METRICS_PROTOCOL_VARIABLE = "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL";

/**
 * The protocol settings accepted. Both mean OTLP over HTTP, where the
 * collector tells JSON from protobuf by content type. gRPC is refused.
 */
const HTTP_PROTOCOLS: readonly string[] = ["http/json", "http/protobuf"];

/** Quote characters stripped from a pasted value. */
const QUOTES = ['"', "'"];

/**
 * pasted cleans up a variable's value: it strips a leading `NAME=` and
 * surrounding quotes, as left by copying a shell snippet.
 */
function pasted(name: string, text: string | undefined): string {
  let value = (text ?? "").trim();
  if (value.startsWith(`${name}=`)) value = value.slice(name.length + 1).trim();
  const quote = QUOTES.find((q) => value.length > 1 && value.startsWith(q) && value.endsWith(q));
  return quote === undefined ? value : value.slice(1, -1).trim();
}

/**
 * otlpHeaders parses an OTEL_EXPORTER_OTLP_HEADERS value: comma-separated
 * `key=value` pairs with percent-encoded values.
 */
export function otlpHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pasted(HEADERS_VARIABLE, text).split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}

/** Collector is where metrics are posted, and the headers to send. */
export interface Collector {
  /** The full URL a metrics request is posted to. */
  url: string;
  headers: Record<string, string>;
}

/**
 * whyNot describes what is wrong with an endpoint value by its shape and
 * length alone, since it may hold a secret.
 */
function whyNot(value: string): string {
  if (/^authorization\s*=/i.test(value)) {
    return `it holds what ${HEADERS_VARIABLE} should, so the two look swapped`;
  }
  if (!/^https?:\/\//i.test(value)) {
    return `it does not start with https://, and is ${value.length} characters long`;
  }
  return `it starts as a URL does and cannot be read as one, and is ${value.length} characters long`;
}

/** setOf returns the first of `variables` with a non-empty value, and that value. */
function setOf(
  env: Readonly<Record<string, string | undefined>>,
  variables: readonly string[],
): { variable: string; value: string } {
  for (const variable of variables) {
    const value = pasted(variable, env[variable]);
    if (value !== "") return { variable, value };
  }
  return { variable: variables[0]!, value: "" };
}

/**
 * collector reads the metrics endpoint, protocol and headers from the
 * environment. It returns undefined when the endpoint variables are empty,
 * and throws for an endpoint that fails to parse as a URL, a protocol other
 * than HTTP, or a headers value that parses to zero headers.
 */
export function collector(
  env: Readonly<Record<string, string | undefined>>,
): Collector | undefined {
  const { variable, value: endpoint } = setOf(env, [METRICS_ENDPOINT_VARIABLE, ENDPOINT_VARIABLE]);
  if (endpoint === "") return undefined;

  const url =
    variable === METRICS_ENDPOINT_VARIABLE
      ? endpoint
      : `${endpoint.replace(/\/+$/, "")}${METRICS_PATH}`;
  if (!/^https?:\/\//i.test(endpoint) || !URL.canParse(url)) {
    throw new Error(`${variable} is not a URL · ${whyNot(endpoint)}`);
  }

  const protocol = setOf(env, [METRICS_PROTOCOL_VARIABLE, PROTOCOL_VARIABLE]);
  if (protocol.value !== "" && !HTTP_PROTOCOLS.includes(protocol.value)) {
    throw new Error(
      `${protocol.variable} is ${protocol.value}, and metrics are sent as OTLP over HTTP · set it to http/json or leave it unset`,
    );
  }

  const given = setOf(env, [METRICS_HEADERS_VARIABLE, HEADERS_VARIABLE]);
  const headers = otlpHeaders(given.value);
  if (given.value !== "" && Object.keys(headers).length === 0) {
    throw new Error(
      `${given.variable} holds no header · it is read as key=value pairs with commas between`,
    );
  }
  return { url, headers };
}
