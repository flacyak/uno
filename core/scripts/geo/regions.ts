/**
 * @fileoverview Builds the place table's regions from admin 1: for each
 * country a region reading covers, its first-level regions by ISO 3166-2
 * code, with their names in English, Spanish, Portuguese and the local one.
 */

import { distinct, text } from './places.ts';
import type { Properties } from './source.ts';

/** A region as places.json holds it: its ISO 3166-2 code and its names. */
export interface Region {
  code: string;
  names: string[];
}

/**
 * The countries whose regions are read: the nine Natural Earth draws at its
 * middle scale, and Mexico and Germany, whose admin 1 is their first level.
 */
const REGION_COUNTRIES = 'AU BR CA CN DE ID IN MX RU US ZA'.split(' ');
const NAME_FIELDS = ['name', 'name_en', 'name_es', 'name_pt'];
/** What separates the names `name_local` holds. */
const LOCAL_SEPARATOR = '|';

/**
 * regions builds each country's regions, ascending by code. A feature is a
 * region of its country only when its ISO code names that country, so in the
 * United States' point of view Crimea and Sevastopol, coded UA, are none of
 * Russia's, and parts Natural Earth codes with a `~`, as Jervis Bay, have no
 * ISO code and are none. Features of one code, as New South Wales and Lord
 * Howe Island, are one region.
 */
export function regions(features: readonly Properties[]) {
  const out: Record<string, Region[]> = {};
  for (const country of REGION_COUNTRIES) {
    const iso = new RegExp(`^${country}-[A-Z0-9]+$`);
    const byCode = new Map<string, Properties[]>();
    for (const p of features) {
      const code = text(p, 'iso_3166_2') ?? '';
      if (text(p, 'iso_a2') !== country || !iso.test(code)) continue;
      byCode.set(code, [...(byCode.get(code) ?? []), p]);
    }
    const codes = [...byCode.keys()].sort((a, b) => (a < b ? -1 : 1));
    out[country] = codes.map((code) => {
      const parts = byCode.get(code)!;
      const local = parts.map((p) => text(p, 'name_local') ?? '');
      const names = parts.flatMap((p) => NAME_FIELDS.map((f) => text(p, f)));
      const locals = local.flatMap((n) => n.split(LOCAL_SEPARATOR));
      return { code, names: distinct([...names, ...locals.filter(Boolean)]) };
    });
  }
  return out;
}
