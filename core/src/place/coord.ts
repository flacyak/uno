/**
 * @fileoverview Which number columns hold a latitude or a longitude in
 * decimal degrees, and which pair: the header decides, the range confirms.
 */

import { headerWords } from './words.ts';

/** Which coordinate a column holds. */
export type Coord = 'lat' | 'lon';

/** The most a longitude reads, either side of the prime meridian. */
export const LON_AT_MOST = 180;

/** The header words that name each coordinate, in English, Spanish and Portuguese. */
const COORD_WORDS: Record<Coord, ReadonlySet<string>> = {
  lat: new Set(['lat', 'latitude', 'latitud']),
  lon: new Set(['lon', 'lng', 'long', 'longitude', 'longitud']),
};

/**
 * inferCoord names the coordinate a number column holds: one its header has
 * a word for, when every sampled value lies within LON_AT_MOST. A latitude
 * past 90 still reads as one, so a swapped pair is offered as a pair and its
 * map can say so.
 */
export function inferCoord(
  header: string,
  values: readonly number[],
): Coord | undefined {
  if (values.length === 0 || values.some((v) => Math.abs(v) > LON_AT_MOST))
    return undefined;
  const words = headerWords(header);
  if (words.some((w) => COORD_WORDS.lat.has(w))) return 'lat';
  if (words.some((w) => COORD_WORDS.lon.has(w))) return 'lon';
  return undefined;
}

/** A latitude column and the longitude column it pairs with. */
export interface CoordPair {
  lat: number;
  lon: number;
}

/**
 * pairCoords pairs each latitude column, left to right, with a longitude
 * none has taken: the one whose header's other words are its own, else the
 * nearest to its right, then to its left. So `pickup_lat` goes with
 * `pickup_lon` and `dropoff_lat` with `dropoff_lon`.
 */
export function pairCoords(
  columns: ReadonlyArray<{ header: string; coord?: Coord }>,
): CoordPair[] {
  const others = (col: number, coord: Coord) =>
    headerWords(columns[col]!.header)
      .filter((w) => !COORD_WORDS[coord].has(w))
      .join(' ');
  const free = new Set(
    columns.flatMap((c, col) => (c.coord === 'lon' ? [col] : [])),
  );
  const pairs: CoordPair[] = [];
  columns.forEach((c, lat) => {
    if (c.coord !== 'lat') return;
    const open = [...free];
    const same = open.find((lon) => others(lon, 'lon') === others(lat, 'lat'));
    const right = open.find((lon) => lon > lat);
    const left = open.filter((lon) => lon < lat).pop();
    const lon = same ?? right ?? left;
    if (lon === undefined) return;
    free.delete(lon);
    pairs.push({ lat, lon });
  });
  return pairs;
}
