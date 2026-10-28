/**
 * @fileoverview textOf writes Parquet bytes as the text they hold where they
 * are UTF-8, and as 0x-hex where they are not.
 */

import type { SchemaElement } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { stringFromBytes } from '@ingest/parquet/values';

import { textsOf } from './texts.ts';

const encoder = new TextEncoder();

/** The bytes a UUID holds. */
const UUID_BYTES = 16;

const HEX = 16;

/** Bytes written as hex, two digits each. */
function bytesOf(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, HEX));
}

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

test('a string comes over from hyparquet as the text textOf writes', () => {
  expect(stringFromBytes(encoder.encode('héllo'))).toBe('héllo');
  expect(stringFromBytes(bytesOf('ff61'))).toBe('0xff61');
  expect(stringFromBytes(new Uint8Array())).toBe('');
  expect(stringFromBytes(undefined)).toBeUndefined();
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

test('a UUID reads in canonical form, and one of the wrong length as 0x-hex', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'FIXED_LEN_BYTE_ARRAY',
    type_length: UUID_BYTES,
    logical_type: { type: 'UUID' },
  };
  const uuid = bytesOf('123e4567e89b12d3a456426614174000');
  // Sixteen bytes that are UTF-8, which a UUID does not read as.
  const text = encoder.encode('abcdefghijklmnop');
  expect(textsOf(element, [uuid, text, new Uint8Array([0xab])])).toEqual([
    '123e4567-e89b-12d3-a456-426614174000',
    '61626364-6566-6768-696a-6b6c6d6e6f70',
    '0xab',
  ]);
});
