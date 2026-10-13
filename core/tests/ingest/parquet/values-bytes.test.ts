/**
 * @fileoverview textOf writes Parquet bytes as the text they hold where they
 * are UTF-8, and as 0x-hex where they are not.
 */

import type { SchemaElement } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { textsOf } from './texts.ts';

const encoder = new TextEncoder();

test('a string reads as the UTF-8 it holds, a byte order mark kept', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'BYTE_ARRAY',
    logical_type: { type: 'STRING' },
  };
  const values = [
    encoder.encode('héllo, 世界'),
    new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
    new Uint8Array(),
  ];
  expect(textsOf(element, values)).toEqual(['héllo, 世界', '﻿a', '']);
});

test('JSON and an enum read as the text they were written as', () => {
  const json: SchemaElement = {
    name: 'x',
    type: 'BYTE_ARRAY',
    converted_type: 'JSON',
  };
  expect(textsOf(json, [encoder.encode('{"a": [1, 2.50]}')])).toEqual([
    '{"a": [1, 2.50]}',
  ]);
  const enumeration: SchemaElement = {
    name: 'x',
    type: 'BYTE_ARRAY',
    converted_type: 'ENUM',
  };
  expect(textsOf(enumeration, [encoder.encode('RED')])).toEqual(['RED']);
});

test('invalid UTF-8 reads as 0x-hex', () => {
  const element: SchemaElement = { name: 'x', type: 'BYTE_ARRAY' };
  const values = [
    new Uint8Array([0xff, 0x00, 0x41]),
    // The first two bytes of a three-byte character.
    new Uint8Array([0xe2, 0x82]),
    // A surrogate, which UTF-8 never encodes.
    new Uint8Array([0xed, 0xa0, 0x80]),
  ];
  expect(textsOf(element, values)).toEqual(['0xff0041', '0xe282', '0xeda080']);
});

test('fixed-length bytes read as UTF-8 or 0x-hex, as any bytes do', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'FIXED_LEN_BYTE_ARRAY',
    type_length: 2,
  };
  const values = [encoder.encode('ok'), new Uint8Array([0x80, 0x0a])];
  expect(textsOf(element, values)).toEqual(['ok', '0x800a']);
});
