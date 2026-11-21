/**
 * @fileoverview A latitude and a longitude are recognised by a header word
 * and confirmed by their range, and a latitude pairs with the longitude
 * whose other words are its own, or else with the nearest one.
 */

import { describe, expect, test } from 'vite-plus/test';

import { inferCoord, pairCoords } from '@place';

describe('a header word names the coordinate, and the range confirms it', () => {
  test.each([
    ['lat', [40.7, -33.9], 'lat'],
    ['pickup_latitude', [40.7], 'lat'],
    ['Latitud', [19.4], 'lat'],
    ['dropoffLng', [-74.0], 'lon'],
    ['long', [151.2, -179.9], 'lon'],
    ['longitud', [-99.1], 'lon'],
    ['LON', [180, -180], 'lon'],
  ])('%s over %j reads as %s', (header, values, coord) =>
    expect(inferCoord(header, values)).toBe(coord),
  );

  test.each([
    ['price', [45.3]],
    ['lat', [190]],
    ['lon', [181]],
    ['latency', [12]],
    ['lat', []],
  ])('%s over %j reads as none', (header, values) =>
    expect(inferCoord(header, values)).toBeUndefined(),
  );

  test('a latitude past 90 is still one, so a swapped pair is offered as a pair', () => {
    expect(inferCoord('lat', [151.2, 40])).toBe('lat');
  });
});

describe('a latitude pairs with its longitude', () => {
  const columns = (...headers: Array<[string, 'lat' | 'lon' | undefined]>) =>
    headers.map(([header, coord]) =>
      coord === undefined ? { header } : { header, coord },
    );

  test('by the other words of their headers', () => {
    const cols = columns(
      ['pickup_lat', 'lat'],
      ['dropoff_lat', 'lat'],
      ['dropoff_lon', 'lon'],
      ['pickup_lon', 'lon'],
    );
    expect(pairCoords(cols)).toEqual([
      { lat: 0, lon: 3 },
      { lat: 1, lon: 2 },
    ]);
  });

  test('else with the nearest longitude to its right, then to its left', () => {
    const cols = columns(
      ['y', 'lon'],
      ['id', undefined],
      ['lat', 'lat'],
      ['x', 'lon'],
    );
    expect(pairCoords(cols)).toEqual([{ lat: 2, lon: 3 }]);
    const left = columns(['lng', 'lon'], ['lat', 'lat'], ['id', undefined]);
    expect(pairCoords(left)).toEqual([{ lat: 1, lon: 0 }]);
  });

  test('a longitude pairs once', () => {
    const cols = columns(['a lat', 'lat'], ['b lat', 'lat'], ['lon', 'lon']);
    expect(pairCoords(cols)).toEqual([{ lat: 0, lon: 2 }]);
  });
});
