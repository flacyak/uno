// Tests for notation/unicode.ts.

import { expect, test } from 'vite-plus/test';

import { formatU } from '../../src/notation/index.ts';

test('formatU names a code point without printing it', () => {
  expect(formatU('√')).toBe('U+221A');
  expect(formatU('∑')).toBe('U+2211');
});
