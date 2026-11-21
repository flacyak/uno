/**
 * @fileoverview The generator reads Natural Earth only at the bytes it
 * pins: a cached layer whose SHA-256 differs is refused, never read.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

import {
  LAYERS,
  NE_COMMIT,
  features,
  sha256,
} from '../../scripts/geo/source.ts';

const LAYER = 'ne_10m_admin_0_countries_usa';
let cache = '';
afterEach(() => rmSync(cache, { recursive: true, force: true }));

test('a layer whose bytes are not the pinned ones is refused', async () => {
  cache = mkdtempSync(join(tmpdir(), 'geo-'));
  const changed = JSON.stringify({ features: [{ properties: { NAME: 'X' } }] });
  writeFileSync(join(cache, `${NE_COMMIT}-${LAYER}.geojson`), changed);
  await expect(features(LAYER, cache)).rejects.toThrow('differs');
});

test('each layer is pinned to a SHA-256', () => {
  expect(sha256(new TextEncoder().encode(''))).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  for (const hash of Object.values(LAYERS))
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
});
