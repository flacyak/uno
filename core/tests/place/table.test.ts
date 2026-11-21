/**
 * @fileoverview What the generated place table holds: every country by its
 * ISO code, and the first-level regions of the countries a region reading
 * covers, each by an ISO 3166-2 code of its own country.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

interface Place {
  code: string;
  names: string[];
}
interface Table {
  countries: Place[];
  regions: Record<string, Place[]>;
}

const table = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../src/place/data/places.json'),
    'utf8',
  ),
) as Table;

test('the table holds 239 countries', () => {
  expect(table.countries).toHaveLength(239);
});

test('each region country holds its first-level regions', () => {
  const held = Object.fromEntries(
    Object.entries(table.regions).map(([c, r]) => [c, r.length]),
  );
  // 50 states and DC; Puerto Rico is a country of its own in admin 0.
  expect(held).toMatchObject({ US: 51, CA: 13, MX: 32, DE: 16, ZA: 9, AU: 8 });
  // France's 18 regions, not its 101 departments; Italy's 20, not its 110
  // provinces; Spain's 19 communities and cities; the UK's four nations.
  expect(held).toMatchObject({ FR: 18, IT: 20, ES: 19, GB: 4 });
});

test('every region is coded under its own country, with a name', () => {
  for (const [country, regions] of Object.entries(table.regions))
    for (const r of regions) {
      expect(r.code.startsWith(`${country}-`), r.code).toBe(true);
      expect(r.names.length, r.code).toBeGreaterThan(0);
    }
});

test('Crimea and Sevastopol are no region of Russia', () => {
  const names = table.regions['RU']!.flatMap((r) => r.names);
  expect(names).not.toContain('Crimea');
  expect(names).not.toContain('Sevastopol');
});
