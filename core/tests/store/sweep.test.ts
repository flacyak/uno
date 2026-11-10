/**
 * @fileoverview A localhost sweep reaches every stand-in and is not recorded.
 *
 * Apps on the machine, T3 Code among them, sweep localhost and send each new
 * listener one plain GET / from Node's fetch. Tests hold exact counts of
 * what a stand-in saw, so none records that request.
 */

import { expect, test } from 'vite-plus/test';

import { host } from './host.ts';
import { portal } from './portal.ts';
import { bucket } from './standin.ts';
import { sts } from './stsstandin.ts';

/** A container path the host does not serve while no container is set. */
const UNSERVED = '/v2/credentials/7f3c';

test.each([
  ['the S3 stand-in', bucket],
  ['the STS stand-in', () => sts([], new Map())],
  ['the SSO portal', () => portal(new Map())],
  ['the host', host],
])('%s records no sweep', async (_, start) => {
  const standin = await start();
  await (await fetch(standin.endpoint)).text();
  await standin.close();
  expect(standin.seen).toEqual([]);
});

test('the host records a request for a path it does not serve', async () => {
  const h = await host();
  await (await fetch(`${h.endpoint}${UNSERVED}`)).text();
  await h.close();
  expect(h.seen.map((r) => r.path)).toEqual([UNSERVED]);
});
