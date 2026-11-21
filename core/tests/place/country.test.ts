/**
 * @fileoverview A cell reads as a country by its ISO code in any case, or by
 * a name in any of six languages, with or without its marks; a key two
 * countries share reads as neither, and a numeric code is never read.
 */

import { describe, expect, test } from 'vite-plus/test';

import { placeKey, readCountry as read } from '@place';

describe('a country reads by its code', () => {
  test.each([
    ['US', 'US'],
    ['us', 'US'],
    ['USA', 'US'],
    ['deu', 'DE'],
    [' FR ', 'FR'],
    ['XK', 'XK'],
    ['TW', 'TW'],
  ])('%s reads as %s', (v, code) => expect(read(v)).toBe(code));
});

describe('a country reads by its name', () => {
  test.each([
    ['Germany', 'DE'],
    ['Alemania', 'DE'],
    ['Deutschland', 'DE'],
    ['Allemagne', 'DE'],
    ['Germania', 'DE'],
    ['Alemanha', 'DE'],
    ['United States of America', 'US'],
    ['Estados Unidos', 'US'],
    ['Russian Federation', 'RU'],
    ['Viet Nam', 'VN'],
    ['Korea, Republic of', 'KR'],
    ["Korea, Democratic People's Republic of", 'KP'],
    ["Côte d'Ivoire", 'CI'],
    ['Cote d’Ivoire', 'CI'],
    ['COTE D IVOIRE', 'CI'],
    ['the Netherlands', 'NL'],
    ['Bolivia, Plurinational State of', 'BO'],
  ])('%s reads as %s', (v, code) => expect(read(v)).toBe(code));
});

describe('what reads as no country', () => {
  test.each([
    ['840', 'a numeric code, which a column of ids would read as'],
    ['', 'a blank'],
    ['Atlantis', 'no country'],
    ['Saint Martin', 'the French part and the Dutch part both'],
    ['Clipperton I.', 'an outlying part of France, named for itself'],
  ])('%s, %s', (v) => expect(read(v)).toBeUndefined());
});

test('a name is compared after one normalisation', () => {
  expect(placeKey('  Côte  d’Ivoire ')).toBe('cote d ivoire');
  expect(placeKey('The Gambia')).toBe('gambia');
  expect(placeKey('SÃO TOMÉ AND PRÍNCIPE')).toBe('sao tome and principe');
});
