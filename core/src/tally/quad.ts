/**
 * @fileoverview The fixed latitude and longitude quadtree a map's fold
 * counts in: level z has 2^z rows of latitude and 2^(z+1) columns of
 * longitude, so every cell is a square of 180 / 2^z degrees.
 */

/** The finest level a fold holds: cells of 180 / 2^20 degrees, about 19 m. */
export const LEVEL_FINEST = 20;

export const LAT_AT_MOST = 90;
export const LON_AT_MOST = 180;
const FINEST_ROWS = 2 ** LEVEL_FINEST;
const FINEST_COLUMNS = 2 * FINEST_ROWS;

/**
 * cellAt is the key of the cell at `level` that holds a point: its row of
 * latitude times the level's 2^(level+1) columns, plus its column. Both are
 * found at LEVEL_FINEST and halved to `level`, so every point lies in its
 * cell's parent at every level. Latitude 90 is in the top row, and
 * longitude 180 is the column of -180.
 */
export function cellAt(lat: number, lon: number, level: number): number {
  const finestRow = Math.floor(
    ((lat + LAT_AT_MOST) / (2 * LAT_AT_MOST)) * FINEST_ROWS,
  );
  const finestColumn = Math.floor(
    ((lon + LON_AT_MOST) / (2 * LON_AT_MOST)) * FINEST_COLUMNS,
  );
  const shift = LEVEL_FINEST - level;
  const row = Math.min(finestRow, FINEST_ROWS - 1) >> shift;
  const column = (finestColumn % FINEST_COLUMNS) >> shift;
  return row * 2 ** (level + 1) + column;
}

/** parentOf is the key at `level` - 1 of the cell `key` at `level`. */
export function parentOf(key: number, level: number): number {
  const columns = 2 ** (level + 1);
  const row = Math.floor(key / columns);
  return (row >> 1) * (columns / 2) + ((key % columns) >> 1);
}
