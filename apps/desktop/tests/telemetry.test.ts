/**
 * @fileoverview The engine's telemetry, sent to a collector only when one is
 * named in the environment. What is sent and how is the core's exporter, in
 * core/tests/store/otlp.test.ts; this is what the desktop decides.
 */

import { expect, test, vi } from "vite-plus/test";

import { exporting } from "@desktop-engine/telemetry";

const ENDPOINT = "https://otlp.example.test/otlp";
const ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: `${ENDPOINT}/`,
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20abc",
};
const VERSION = "1.2.3";

test("a machine that names no collector measures nothing", () => {
  expect(exporting({}, VERSION)).toBeUndefined();
  expect(exporting({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }, VERSION)).toBeUndefined();
});

test("the engine posts to the collector's metrics path as uno-engine, at the app's version", async () => {
  const sent: Array<{ url: string; headers: Headers; body: string }> = [];
  const go: typeof fetch = (input, init) => {
    sent.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const telemetry = exporting(ENV, VERSION, go)!;
  try {
    telemetry.record({ name: "uno.engine.request", kind: "duration", unit: "ms", value: 12 });
    await telemetry.flush();
    expect(sent.length).toBe(1);
    expect(sent[0]!.url).toBe(`${ENDPOINT}/v1/metrics`);
    expect(sent[0]!.headers.get("authorization")).toBe("Basic abc");
    expect(sent[0]!.body).toContain('"uno-engine"');
    expect(sent[0]!.body).toContain(VERSION);
  } finally {
    telemetry.stop();
  }
});

test("an endpoint that cannot be read is said once, and the engine runs unmeasured", () => {
  const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(
      exporting({ OTEL_EXPORTER_OTLP_ENDPOINT: "otlp.example.test/otlp" }, VERSION),
    ).toBeUndefined();
    expect(said).toHaveBeenCalledTimes(1);
    expect(said.mock.calls[0]![0]).toContain("OTEL_EXPORTER_OTLP_ENDPOINT is not a URL");
    expect(said.mock.calls[0]![0]).not.toContain("otlp.example.test");
  } finally {
    said.mockRestore();
  }
});
