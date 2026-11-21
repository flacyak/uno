/**
 * @fileoverview Generates the place table from Natural Earth, pinned in
 * source.ts. Running it again writes the same bytes.
 *
 *   node core/scripts/geo/generate.ts [cache folder, os.tmpdir()/uno-geo]
 *
 * manifest.json beside the data names the source and each file's SHA-256,
 * so a test tells a hand edit from a generated file.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countries } from './places.ts';
import { regions } from './regions.ts';
import { LAYERS, NE_COMMIT, features, sha256 } from './source.ts';

const cache = process.argv[2] ?? join(tmpdir(), 'uno-geo');
const out = join(import.meta.dirname, '../../src/place/data');
const admin0 = await features('ne_10m_admin_0_countries_usa', cache);
const admin1 = await features('ne_10m_admin_1_states_provinces', cache);
const table = { countries: countries(admin0), regions: regions(admin1) };
const files = { 'places.json': table };

mkdirSync(out, { recursive: true });
const hashes: Record<string, string> = {};
for (const [name, data] of Object.entries(files)) {
  const bytes = new TextEncoder().encode(JSON.stringify(data) + '\n');
  writeFileSync(join(out, name), bytes);
  hashes[name] = sha256(bytes);
}
// Names in six languages come from Node's ICU too, so the manifest names it.
const icu = process.versions.icu;
const manifest = { source: { commit: NE_COMMIT, layers: LAYERS, icu }, hashes };
const written = JSON.stringify(manifest, null, 2) + '\n';
writeFileSync(join(out, 'manifest.json'), written);
