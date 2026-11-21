/**
 * @fileoverview Builds the place table's countries from admin 0: each ISO
 * 3166-1 alpha-2 code, its alpha-3 code, and its names in six languages.
 */

import type { Properties } from './source.ts';

/** A country as places.json holds it: its codes, and its names first seen first. */
export interface Country {
  code: string;
  /** Absent where ISO gives none, as for Kosovo. */
  a3?: string;
  names: string[];
}

/** What Natural Earth writes where a field has no value. */
const NONE = '-99';
/** The languages a country's name is read in, as `Intl.DisplayNames` names them. */
const LANGUAGES = ['en', 'es', 'pt', 'fr', 'de', 'it'];
/** The admin 0 fields that hold a country's names in those languages. */
const NAME_FIELDS = (
  'NAME NAME_LONG NAME_EN ADMIN FORMAL_EN NAME_CIAWF NAME_SORT BRK_NAME ' +
  'ABBREV NAME_ES NAME_PT NAME_FR FORMAL_FR NAME_DE NAME_IT'
).split(' ');
/** ISO 3166-1's English short names that no field above writes. */
const ISO_NAMES: Record<string, string> = {
  BO: 'Bolivia, Plurinational State of',
  CD: 'Congo, The Democratic Republic of the',
  FK: 'Falkland Islands (Malvinas)',
  IR: 'Iran, Islamic Republic of',
  KP: "Korea, Democratic People's Republic of",
  KR: 'Korea, Republic of',
  MD: 'Moldova, Republic of',
  NL: 'Netherlands, Kingdom of the',
  PS: 'Palestine, State of',
  TZ: 'Tanzania, United Republic of',
  VA: 'Holy See',
  VE: 'Venezuela, Bolivarian Republic of',
  VG: 'Virgin Islands (British)',
};

/** text is `p[field]` when it holds a value. */
function text(p: Properties, field: string): string | undefined {
  const v = p[field];
  return typeof v === 'string' && v !== NONE && v.trim() !== '' ? v : undefined;
}

/**
 * countries builds one entry per alpha-2 code, ascending. A code that names
 * several features, such as France and Clipperton, takes its names from its
 * home part, whose own code is the country's, so an outlying part's name
 * never reads as its country.
 */
export function countries(features: readonly Properties[]): Country[] {
  const byCode = new Map<string, Properties[]>();
  for (const p of features) {
    const code = text(p, 'ISO_A2_EH');
    if (code !== undefined) byCode.set(code, [...(byCode.get(code) ?? []), p]);
  }
  const named = LANGUAGES.map(
    (l) => new Intl.DisplayNames([l], { type: 'region' }),
  );
  const codes = [...byCode.keys()].sort((a, b) => (a < b ? -1 : 1));
  return codes.map((code) => {
    const all = byCode.get(code)!;
    const home = all.filter((p) => text(p, 'ADM0_A3') === text(p, 'ISO_A3_EH'));
    const parts = home.length > 0 ? home : all;
    const written = [
      ...parts.flatMap((p) => NAME_FIELDS.map((f) => text(p, f))),
      ...named.map((n) => n.of(code)),
      ISO_NAMES[code],
    ].filter((n) => n !== undefined);
    const names = [
      ...new Map(written.map((n) => [n.toLowerCase(), n])).values(),
    ];
    const a3 = text(parts[0]!, 'ISO_A3_EH');
    return a3 === undefined ? { code, names } : { code, a3, names };
  });
}
