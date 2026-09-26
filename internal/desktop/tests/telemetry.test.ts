// The engine's measurements, sent to a collector only where one is named.

import { expect, test } from "vite-plus/test";

import { exporting } from "../src/engine/telemetry.ts";

const ENDPOINT = "https://otlp.example.test/otlp";
const ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: `${ENDPOINT}/`,
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20abc",
};
const VERSION = "1.2.3";
const OBJECT = "https://bucket.example.test/key";
const LENGTH = 4096;

/** One request that went out. */
interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A fetch that keeps what it was asked and answers as a bucket or a collector would. */
function network(): { sent: Sent[]; go: typeof fetch } {
  const sent: Sent[] = [];
  return {
    sent,
    go: (input, init) => {
      sent.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Promise.resolve(
        new Response(null, { status: 206, headers: { "content-length": String(LENGTH) } }),
      );
    },
  };
}

test("a machine that names no collector measures nothing", () => {
  expect(exporting({}, VERSION)).toBeUndefined();
  expect(exporting({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }, VERSION)).toBeUndefined();
});

test("what was measured is posted to the collector's metrics path, signed in as the machine says", async () => {
  const { sent, go } = network();
  const telemetry = exporting(ENV, VERSION, go)!;
  try {
    // Nothing measured is nothing to send.
    await telemetry.flush();
    expect(sent).toEqual([]);

    telemetry.record({
      name: "uno.engine.request",
      kind: "duration",
      unit: "ms",
      value: 12,
      attributes: { request: "rows", outcome: "answered" },
    });
    await telemetry.flush();

    expect(sent.length).toBe(1);
    const post = sent[0]!;
    expect(post.url).toBe(`${ENDPOINT}/v1/metrics`);
    expect(post.method).toBe("POST");
    expect(post.headers.get("authorization")).toBe("Basic abc");
    expect(post.headers.get("content-type")).toBe("application/json");
    expect(post.body).toContain('"uno.engine.request"');
    expect(post.body).toContain('"uno-engine"');
    expect(post.body).toContain(VERSION);
  } finally {
    telemetry.stop();
  }
});

test("requests to S3 are counted on their way through, with nothing of where they went", async () => {
  const { sent, go } = network();
  const telemetry = exporting(ENV, VERSION, go)!;
  try {
    const res = await telemetry.fetch(OBJECT, {
      method: "GET",
      headers: { range: "bytes=0-4095" },
    });
    expect(res.status).toBe(206);
    await telemetry.flush();

    const body = sent[1]!.body;
    expect(body).toContain('"uno.s3.requests"');
    expect(body).toContain('"uno.s3.received"');
    expect(body).toContain(`"asDouble":${LENGTH}`);
    expect(body).toContain('"2xx"');
    expect(body).not.toContain("bucket.example.test");
  } finally {
    telemetry.stop();
  }
});

test("a collector that cannot be reached costs the engine nothing", async () => {
  const telemetry = exporting(ENV, VERSION, () => Promise.reject(new Error("no route")))!;
  try {
    telemetry.record({ name: "uno.engine.request", kind: "duration", unit: "ms", value: 1 });
    await expect(telemetry.flush()).resolves.toBeUndefined();
    // A request to S3 that fails still fails as it did, and is counted.
    await expect(telemetry.fetch(OBJECT)).rejects.toThrow("no route");
  } finally {
    telemetry.stop();
  }
});
