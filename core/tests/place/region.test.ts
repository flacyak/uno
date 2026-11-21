/**
 * @fileoverview A cell reads as a first-level region of one country by its
 * ISO 3166-2 code, by that code without its country, or by a name, and the
 * reading, never the cell, decides what a code two readings share means.
 */

import { describe, expect, test } from 'vite-plus/test';

import { REGION_COUNTRIES, readPlace } from '@place';

const regionOf = (country: string) => (v: string) =>
  readPlace(v, { level: 'region', country });

test('CA is Canada as a country and California as a US state', () => {
  expect(readPlace('CA', { level: 'country' })).toBe('CA');
  expect(regionOf('US')('CA')).toBe('US-CA');
  expect(regionOf('CA')('CA')).toBeUndefined();
});

describe('a region reads by its code, its bare code and its names', () => {
  test.each([
    ['US', 'US-NY', 'US-NY'],
    ['US', 'ny', 'US-NY'],
    ['US', 'New York', 'US-NY'],
    ['CA', 'Colombie-Britannique', undefined],
    ['CA', 'Columbia Británica', 'CA-BC'],
    ['DE', 'Bayern', 'DE-BY'],
    ['DE', 'Bavaria', 'DE-BY'],
    ['DE', 'Baviera', 'DE-BY'],
    ['BR', 'São Paulo', 'BR-SP'],
    ['BR', 'Sao Paulo', 'BR-SP'],
    ['MX', 'Nuevo León', 'MX-NLE'],
    ['RU', 'Псковская область', 'RU-PSK'],
    ['AU', 'Lord Howe Island', 'AU-NSW'],
  ])('in %s, %s reads as %s', (country, v, code) =>
    expect(regionOf(country)(v)).toBe(code),
  );
});

test('in the United States point of view, Crimea is no region of Russia', () => {
  expect(regionOf('RU')('Crimea')).toBeUndefined();
  expect(regionOf('RU')('Sevastopol')).toBeUndefined();
});

test('a part with no ISO 3166-2 code is no region', () => {
  expect(regionOf('AU')('Jervis Bay Territory')).toBeUndefined();
  expect(regionOf('CN')('Paracel Islands')).toBeUndefined();
});

test('a country with no region reading reads no region', () => {
  expect(REGION_COUNTRIES).not.toContain('JP');
  expect(regionOf('JP')('Tokyo')).toBeUndefined();
});

describe('France, Italy, Spain and the United Kingdom read at their first level', () => {
  test.each([
    ['FR', 'Bretagne', 'FR-BRE'],
    ['FR', 'Brittany', 'FR-BRE'],
    ['FR', 'IDF', 'FR-IDF'],
    ['FR', 'Corse', 'FR-20R'],
    ['FR', 'Réunion', 'FR-974'],
    ['FR', 'Nord', undefined],
    ['IT', 'Lombardia', 'IT-25'],
    ['IT', 'Lombardy', 'IT-25'],
    ['IT', 'Sicilia', 'IT-82'],
    ['IT', 'Milano', undefined],
    ['ES', 'Cataluña', 'ES-CT'],
    ['ES', 'Catalonia', 'ES-CT'],
    ['ES', 'Melilla', 'ES-ML'],
    ['ES', 'Barcelona', undefined],
    ['GB', 'Scotland', 'GB-SCT'],
    ['GB', 'Northern Ireland', 'GB-NIR'],
    ['GB', 'ENG', 'GB-ENG'],
    ['GB', 'Derry', undefined],
  ])('in %s, %s reads as %s', (country, v, code) =>
    expect(regionOf(country)(v)).toBe(code),
  );
});
