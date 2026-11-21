/**
 * @fileoverview A column of places is recognised from its sample: the
 * reading that reads the largest share of its cells wins when that share is
 * at least PLACE_SHARE_LEAST, and the header breaks a tie.
 */

import { describe, expect, test } from 'vite-plus/test';

import { PLACE_SHARE_LEAST, headerWords, inferPlace } from '@place';

const COUNTRIES = { level: 'country' };
const STATES = { level: 'region', country: 'US' };

describe('the reading that reads most of the sample wins', () => {
  test('countries by name', () => {
    expect(
      inferPlace(['Germany', 'France', 'Brasil', 'Japan'], 'market'),
    ).toEqual(COUNTRIES);
  });
  test('one value such as NY decides for states', () => {
    expect(inferPlace(['CA', 'DE', 'IN', 'NY'], 'code')).toEqual(STATES);
  });
  test('CA, DE and IN read both ways and stay countries', () => {
    expect(inferPlace(['CA', 'DE', 'IN'], 'code')).toEqual(COUNTRIES);
  });
  test('a header that says state breaks the tie for states', () => {
    expect(inferPlace(['CA', 'DE', 'IN'], 'ship_state')).toEqual(STATES);
    expect(inferPlace(['CA', 'DE', 'IN'], 'Estado')).toEqual(STATES);
  });
  test('Bayern and Sachsen read as German regions', () => {
    expect(inferPlace(['Bayern', 'Sachsen', 'Hessen'], 'land')).toEqual({
      level: 'region',
      country: 'DE',
    });
  });
  test('blanks are not counted', () => {
    expect(inferPlace(['Texas', '', ' ', 'Ohio'], 'where')).toEqual(STATES);
  });
});

describe('a column that is not places reads as none', () => {
  test(`under ${PLACE_SHARE_LEAST} of its cells read`, () => {
    expect(
      inferPlace(['Germany', 'France', 'Acme', 'Globex', 'Initech'], 'x'),
    ).toBeUndefined();
  });
  test('no cells at all', () => {
    expect(inferPlace([], 'country')).toBeUndefined();
  });
});

test('a header splits into words at non-letters and at a case change', () => {
  expect(headerWords('pickup_latitude')).toEqual(['pickup', 'latitude']);
  expect(headerWords('PickupLatitude')).toEqual(['pickup', 'latitude']);
  expect(headerWords('pickup latitude')).toEqual(['pickup', 'latitude']);
  expect(headerWords('País')).toEqual(['país']);
});
