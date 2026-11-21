/**
 * @fileoverview The Natural Earth layers the map data is made from, pinned
 * to a commit and to each file's SHA-256. Natural Earth is public domain.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The commit of github.com/nvkelso/natural-earth-vector read. */
export const NE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';

/** Each layer read and its SHA-256: admin 0 as the United States draws it. */
export const LAYERS = {
  ne_10m_admin_0_countries_usa:
    'd3166691d3d86f113c0d8db52506f4b72936513691d1593f47010fed01fc0b93',
} as const;

/** A feature's properties, as Natural Earth writes them. */
export type Properties = Record<string, string | number | null>;

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** features reads a layer's features, fetching it into `cache` once. */
export async function features(
  layer: keyof typeof LAYERS,
  cache: string,
): Promise<Properties[]> {
  const path = join(cache, `${NE_COMMIT}-${layer}.geojson`);
  if (!existsSync(path)) {
    const url = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_COMMIT}/geojson/${layer}.geojson`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== LAYERS[layer]) throw new Error(`${path} differs`);
  const read = JSON.parse(bytes.toString('utf8')) as {
    features: Array<{ properties: Properties }>;
  };
  return read.features.map((f) => f.properties);
}
