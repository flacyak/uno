/**
 * @fileoverview The exporter: what it posts to a collector, what it counts
 * of S3 on the way through, and that a send never costs the engine anything.
 */

import { expect, test } from 'vite-plus/test';

import type { Collector, Resource } from '@engine';
import { S3_RECEIVED, S3_REQUESTS, exporter } from '@store/otlp';
import type { Exporter } from '@store/otlp';

const COLLECTOR: Collector = {
  url: 'https://otlp.example.test/otlp/v1/metrics',
  headers: { authorization: 'Basic abc' },
};
const RESOURCE: Resource = {
  service: 'uno-engine',
  attributes: { 'service.version': '1.2.3' },
};
const OBJECT = 'https://bucket.example.test/key';
const LENGTH = 4096;

/** One request that went out. */
interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A fetch that records each request and answers as a bucket or a collector would. */
function network(): { sent: Sent[]; go: typeof fetch } {
  const sent: Sent[] = [];
  return {
    sent,
    go: (input, init) => {
      sent.push({
        url:
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(
        new Response(null, {
          status: 206,
          headers: { 'content-length': String(LENGTH) },
        }),
      );
    },
  };
}

/** sending runs `body` over an exporter, and stops the exporter's timer after. */
async function sending(
  go: typeof fetch,
  body: (e: Exporter) => Promise<void>,
): Promise<void> {
  const e = exporter(COLLECTOR, RESOURCE, go);
  try {
    await body(e);
  } finally {
    e.stop();
  }
}

test('what was measured is posted to the collector, signed in as it says, under the resource', async () => {
  const { sent, go } = network();
  await sending(go, async (e) => {
    // A flush before any record leaves `sent` empty.
    await e.flush();
    expect(sent).toEqual([]);

    e.record({
      name: 'uno.engine.request',
      kind: 'duration',
      unit: 'ms',
      value: 12,
      attributes: { request: 'rows', outcome: 'answered' },
    });
    await e.flush();

    expect(sent.length).toBe(1);
    const post = sent[0]!;
    expect(post.url).toBe(COLLECTOR.url);
    expect(post.method).toBe('POST');
    expect(post.headers.get('authorization')).toBe('Basic abc');
    expect(post.headers.get('content-type')).toBe('application/json');
    expect(post.body).toContain('"uno.engine.request"');
    expect(post.body).toContain('"uno-engine"');
    expect(post.body).toContain('"1.2.3"');
  });
});

test('requests to S3 are counted on their way through, with nothing of where they went', async () => {
  const { sent, go } = network();
  await sending(go, async (e) => {
    const res = await e.fetch(OBJECT, {
      method: 'GET',
      headers: { range: 'bytes=0-4095' },
    });
    expect(res.status).toBe(206);
    await e.flush();

    const body = sent[1]!.body;
    expect(body).toContain(`"${S3_REQUESTS}"`);
    expect(body).toContain(`"${S3_RECEIVED}"`);
    expect(body).toContain(`"asDouble":${LENGTH}`);
    expect(body).toContain('"2xx"');
    expect(body).not.toContain('bucket.example.test');
  });
});

test('sends go one at a time, so a close during a send on the timer follows it', async () => {
  const { sent, go } = network();
  let answer: (() => void) | undefined;
  const slow: typeof fetch = async (input, init) => {
    await new Promise<void>((resolve) => {
      answer = resolve;
    });
    return go(input, init);
  };
  await sending(slow, async (e) => {
    e.record({
      name: 'uno.engine.request',
      kind: 'duration',
      unit: 'ms',
      value: 1,
    });
    const first = e.flush();
    const second = e.flush();
    await Promise.resolve();
    expect(sent.length, 'the second send waits for the first').toBe(0);
    expect(answer).toBeDefined();
    answer!();
    await first;
    expect(sent.length).toBe(1);
    answer!();
    await second;
    expect(sent.length).toBe(2);
  });
});

test('a collector that cannot be reached costs the engine nothing', async () => {
  const down: typeof fetch = () => Promise.reject(new Error('no route'));
  await sending(down, async (e) => {
    e.record({
      name: 'uno.engine.request',
      kind: 'duration',
      unit: 'ms',
      value: 1,
    });
    await expect(e.flush()).resolves.toBeUndefined();
    // A failed request to S3 still rejects, and is counted.
    await expect(e.fetch(OBJECT)).rejects.toThrow('no route');
  });
});
