/**
 * @fileoverview Parquet values as the text their writer meant. columnsOf
 * reads a footer's schema as the columns a sheet shows, and textOf writes
 * one value of a column.
 *
 * Nothing here imports hyparquet. Its schema elements fit Element as they
 * are, and the values it reads fit ParquetValue.
 */

import { headerOf } from '../format.ts';

/** How a Parquet file stores a value. */
export type Physical =
  | 'BOOLEAN'
  | 'INT32'
  | 'INT64'
  | 'INT96'
  | 'FLOAT'
  | 'DOUBLE'
  | 'BYTE_ARRAY'
  | 'FIXED_LEN_BYTE_ARRAY';

/** What a time or a timestamp counts. */
export type TimeUnit = 'millis' | 'micros' | 'nanos';

/**
 * Logical is what a stored value means, where that changes how it is
 * written. A string, JSON, an enum and a signed integer are written as
 * their stored value is.
 */
export type Logical =
  | { readonly t: 'decimal'; readonly scale: number }
  | { readonly t: 'timestamp'; readonly unit: TimeUnit; readonly utc: boolean }
  | { readonly t: 'time'; readonly unit: TimeUnit; readonly utc: boolean }
  | { readonly t: 'unsigned' }
  | { readonly t: 'date' }
  | { readonly t: 'uuid' }
  | { readonly t: 'float16' };

/** Primitive is the type of one stored value. */
export interface Primitive {
  readonly t: 'primitive';
  readonly physical: Physical;
  readonly logical?: Logical;
}

/**
 * Shape is the type of a column's values: a primitive, or a list, map or
 * struct of further shapes, which is written as JSON.
 */
export type Shape =
  | Primitive
  | { readonly t: 'list'; readonly of: Shape }
  | { readonly t: 'map'; readonly values: Shape }
  | { readonly t: 'struct'; readonly fields: ReadonlyMap<string, Shape> };

/**
 * Column is a leaf as a sheet shows it: a name unique in its file, and the
 * leaf's field path as an RFC 6901 pointer.
 */
export interface Column {
  readonly name: string;
  readonly key: string;
}

/** Leaf is one column of a Parquet file. A struct is not one; each field is. */
export interface Leaf {
  readonly column: Column;
  /** The field names from the top of the schema down to this column. */
  readonly path: readonly string[];
  readonly shape: Shape;
}

/** Annotation is a schema element's logical type, in hyparquet's fields. */
export interface Annotation {
  readonly type: string;
  readonly scale?: number;
  readonly unit?: string;
  readonly isAdjustedToUTC?: boolean;
  readonly isSigned?: boolean;
}

/**
 * Element is one element of a footer's schema, as hyparquet's SchemaElement
 * holds it. The schema lists a group's children after it, depth first.
 */
export interface Element {
  readonly name: string;
  readonly type?: Physical;
  readonly repetition_type?: 'REQUIRED' | 'OPTIONAL' | 'REPEATED';
  readonly num_children?: number;
  readonly converted_type?: string;
  readonly scale?: number;
  readonly logical_type?: Annotation;
}

/**
 * Scalar is one stored value as hyparquet reads it with identity parsers and
 * no DECIMAL annotation. A decimal is its unscaled integer, and a string or
 * binary is its bytes.
 */
type Scalar =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Uint8Array;

/**
 * ParquetValue is one value of a column as hyparquet assembles it: a stored
 * value, the array of a LIST or a repeated field, or the object of a MAP or
 * a struct. A MAP's object is keyed by String of each stored key, so a key
 * handed over as bytes reads as their numbers joined by commas.
 */
export type ParquetValue =
  | Scalar
  | readonly ParquetValue[]
  | { readonly [key: string]: ParquetValue };

/** The significant digits that write any float32 so it reads back exactly. */
export const FLOAT32_DIGITS = 9;

/** The significant digits that write any float16 so it reads back exactly. */
const FLOAT16_DIGITS = 5;

/**
 * A float16's stored fraction bits, its smallest normal exponent, which a
 * subnormal's step shares, and its largest finite value.
 */
const FLOAT16_FRACTION_BITS = 10;
const FLOAT16_MIN_EXPONENT = -14;
const FLOAT16_MAX = 65504;

/** The bits an INT32 and an INT64 hold, read as unsigned where annotated. */
const INT32_BITS = 32;
const INT64_BITS = 64;

const BYTE_BITS = 8;

/** The radix and width of one byte in 0x-hex. */
const HEX = 16;
const HEX_BYTE_DIGITS = 2;

/** The bytes of a UUID, and the hex digits of each group its form dashes. */
const UUID_BYTES = 16;
const UUID_GROUP_DIGITS: readonly number[] = [8, 4, 4, 4, 12];

/** The digits of a second's fraction that each time unit counts. */
const FRACTION_DIGITS: Readonly<Record<TimeUnit, number>> = {
  millis: 3,
  micros: 6,
  nanos: 9,
};

const DECIMAL_RADIX = 10n;
const SECONDS_PER_MINUTE = 60n;
const MINUTES_PER_HOUR = 60n;
const HOURS_PER_DAY = 24n;
const SECONDS_PER_HOUR = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_HOUR;
const MILLIS_PER_DAY = Number(ticksPerDay('millis'));

/** The digits of an hour, a minute or a second on a clock. */
const CLOCK_DIGITS = 2;

/** A number as RFC 8259 writes one, which NaN and Infinity are not. */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Bytes that are not UTF-8 throw, so they can be written as 0x-hex. A byte
 * order mark is kept, since it is part of the value.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A schema element with its children. */
interface Tree {
  readonly element: Element;
  readonly children: readonly Tree[];
}

const UNSIGNED: Logical = { t: 'unsigned' };

/**
 * hyparquet reads an INT96 with no converted type as nanoseconds since 1970.
 * Nothing in the file says whether they count from UTC.
 */
const INT96_TIMESTAMP: Logical = { t: 'timestamp', unit: 'nanos', utc: false };

/** The time units hyparquet names, as Logical names them. */
const UNITS: ReadonlyMap<string, TimeUnit> = new Map([
  ['MILLIS', 'millis'],
  ['MICROS', 'micros'],
  ['NANOS', 'nanos'],
]);

/**
 * What a converted type means, on an element with no logical type that says
 * otherwise. The legacy times and timestamps count from UTC.
 */
const CONVERTED: ReadonlyMap<string, Logical> = new Map<string, Logical>([
  ['DATE', { t: 'date' }],
  ['TIMESTAMP_MILLIS', { t: 'timestamp', unit: 'millis', utc: true }],
  ['TIMESTAMP_MICROS', { t: 'timestamp', unit: 'micros', utc: true }],
  ['TIME_MILLIS', { t: 'time', unit: 'millis', utc: true }],
  ['TIME_MICROS', { t: 'time', unit: 'micros', utc: true }],
  ['UINT_8', UNSIGNED],
  ['UINT_16', UNSIGNED],
  ['UINT_32', UNSIGNED],
  ['UINT_64', UNSIGNED],
]);

/**
 * columnsOf reads a footer's schema as the file's columns, in schema order.
 * A struct's fields flatten to dotted names, and a LIST, a MAP or a repeated
 * field is one column. A name already taken gets headerOf's suffix.
 */
export function columnsOf(schema: readonly Element[]): Leaf[] {
  const found: Array<Omit<Leaf, 'column'>> = [];
  const walk = (node: Tree, path: readonly string[]): void => {
    if (!isStruct(node)) {
      found.push({ path, shape: shapeOf(node) });
      return;
    }
    for (const child of node.children) {
      walk(child, [...path, child.element.name]);
    }
  };
  for (const child of treeOf(schema).children) {
    walk(child, [child.element.name]);
  }
  const names = headerOf(found.map(({ path }) => path.join('.')));
  return found.map((leaf, i) => ({
    column: { name: names[i]!, key: pointerOf(leaf.path) },
    ...leaf,
  }));
}

/** The schema's root, with every element under its group. */
function treeOf(schema: readonly Element[]): Tree {
  let next = 0;
  const read = (): Tree => {
    const element = schema[next++];
    if (element === undefined) {
      throw new Error('parquet schema ends inside a group');
    }
    const children = Array.from({ length: element.num_children ?? 0 }, read);
    return { element, children };
  };
  return read();
}

/** The RFC 6901 pointer to a field path. */
function pointerOf(path: readonly string[]): string {
  return path
    .map((name) => `/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

/** Whether a node is a struct, whose fields are columns of their own. */
function isStruct(node: Tree): boolean {
  return (
    node.children.length > 0 &&
    node.element.repetition_type !== 'REPEATED' &&
    !isList(node) &&
    !isMap(node)
  );
}

/** Whether hyparquet reads a group as a LIST, by its own test. */
function isList({ element, children: [group, ...rest] }: Tree): boolean {
  return (
    element.converted_type === 'LIST' &&
    rest.length === 0 &&
    group?.element.repetition_type === 'REPEATED' &&
    group.children.length <= 1
  );
}

/** Whether hyparquet reads a group as a MAP, by its own test. */
function isMap({ element, children: [group, ...rest] }: Tree): boolean {
  return (
    element.converted_type === 'MAP' &&
    rest.length === 0 &&
    group?.element.repetition_type === 'REPEATED' &&
    group.children.length === 2 &&
    group.children.every((c) => c.element.repetition_type !== 'REPEATED')
  );
}

/** The shape of a node's values. A repeated node holds a list of them. */
function shapeOf(node: Tree): Shape {
  const shape = valueShapeOf(node);
  return node.element.repetition_type === 'REPEATED'
    ? { t: 'list', of: shape }
    : shape;
}

/**
 * The shape of one value of a node. A LIST's values are its repeated
 * group's one child, or the group itself where it has none.
 */
function valueShapeOf(node: Tree): Shape {
  const { element, children } = node;
  const [group] = children;
  if (group === undefined) return primitiveOf(element);
  if (isMap(node)) return { t: 'map', values: shapeOf(group.children[1]!) };
  if (isList(node)) {
    const [item] = group.children;
    return { t: 'list', of: item ? shapeOf(item) : valueShapeOf(group) };
  }
  return {
    t: 'struct',
    fields: new Map(
      children.map((child) => [child.element.name, shapeOf(child)]),
    ),
  };
}

/** The primitive a leaf element stores, with its annotation. */
function primitiveOf(element: Element): Primitive {
  if (element.type === undefined) {
    throw new Error(`parquet column ${element.name} has no type`);
  }
  return {
    t: 'primitive',
    physical: element.type,
    logical: logicalOf(element),
  };
}

/** What an element's annotation means, from its logical or converted type. */
function logicalOf(element: Element): Logical | undefined {
  const { logical_type: annotation, converted_type: converted } = element;
  const unit = UNITS.get(annotation?.unit ?? '');
  const utc = annotation?.isAdjustedToUTC === true;
  if (element.type === 'INT96' && converted === undefined) {
    return INT96_TIMESTAMP;
  }
  switch (annotation?.type) {
    case 'DECIMAL':
      return { t: 'decimal', scale: annotation.scale ?? 0 };
    case 'TIMESTAMP':
      return unit && { t: 'timestamp', unit, utc };
    case 'TIME':
      return unit && { t: 'time', unit, utc };
    case 'INTEGER':
      return annotation.isSigned === false ? UNSIGNED : undefined;
    case 'DATE':
      return { t: 'date' };
    case 'UUID':
      return { t: 'uuid' };
    case 'FLOAT16':
      return { t: 'float16' };
    default:
      return converted === 'DECIMAL'
        ? { t: 'decimal', scale: element.scale ?? 0 }
        : CONVERTED.get(converted ?? '');
  }
}

/**
 * textOf writes a leaf's value as the text its writer meant. A number is
 * exact, at its own precision, a list, a map or a struct is compact JSON,
 * and a null is an empty cell.
 */
export function textOf({ shape }: Leaf, value: ParquetValue): string {
  if (!isScalar(value)) return jsonOf(shape, value);
  return scalarOf(shape.t === 'primitive' ? shape : undefined, value);
}

/** Whether a value is one stored value, rather than an array or an object. */
function isScalar(value: ParquetValue): value is Scalar {
  return (
    typeof value !== 'object' || value === null || value instanceof Uint8Array
  );
}

/** Whether a value is the array of a LIST or a repeated field. */
function isArray(value: ParquetValue): value is readonly ParquetValue[] {
  return Array.isArray(value);
}

/**
 * A value as compact JSON, each value in it written as its shape says. A
 * value whose shape is not known is written as it is.
 */
function jsonOf(shape: Shape | undefined, value: ParquetValue): string {
  if (isScalar(value)) {
    return tokenOf(shape?.t === 'primitive' ? shape : undefined, value);
  }
  if (isArray(value)) {
    const items = shape?.t === 'list' ? shape.of : undefined;
    return `[${value.map((item) => jsonOf(items, item)).join(',')}]`;
  }
  const members = Object.entries(value).map(
    ([key, member]) =>
      `${JSON.stringify(key)}:${jsonOf(memberOf(shape, key), member)}`,
  );
  return `{${members.join(',')}}`;
}

/** The shape of a map's values, or of a struct's field named `key`. */
function memberOf(shape: Shape | undefined, key: string): Shape | undefined {
  switch (shape?.t) {
    case 'map':
      return shape.values;
    case 'struct':
      return shape.fields.get(key);
    default:
      return undefined;
  }
}

/**
 * One stored value as a JSON token: a number where its column writes one
 * that JSON can hold, true or false, null, or else its text as a string.
 */
function tokenOf(primitive: Primitive | undefined, value: Scalar): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  const text = scalarOf(primitive, value);
  return isNumeric(primitive?.logical, value) && JSON_NUMBER.test(text)
    ? text
    : JSON.stringify(text);
}

/**
 * Whether a column writes a value as a number, rather than as a date, a
 * time, a UUID or text.
 */
function isNumeric(logical: Logical | undefined, value: Scalar): boolean {
  switch (logical?.t) {
    case 'decimal':
      return true;
    case 'date':
    case 'time':
    case 'timestamp':
    case 'uuid':
      return false;
    default:
      return typeof value === 'number' || typeof value === 'bigint';
  }
}

/** A value by what its primitive says it means, or as it is with none. */
function scalarOf(primitive: Primitive | undefined, value: Scalar): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return bytesOf(primitive?.logical, value);
  if (primitive && (typeof value === 'number' || typeof value === 'bigint')) {
    return numberOf(primitive, value);
  }
  return String(value);
}

/** A stored number by what its column says it means. */
function numberOf(primitive: Primitive, value: number | bigint): string {
  const { physical, logical } = primitive;
  // String(-0) is '0', which reads back as +0. Only a float is ever -0.
  if (Object.is(value, -0)) return '-0';
  switch (logical?.t) {
    case 'decimal':
      return decimalOf(BigInt(value), logical.scale);
    case 'unsigned': {
      const bits = physical === 'INT64' ? INT64_BITS : INT32_BITS;
      return String(BigInt.asUintN(bits, BigInt(value)));
    }
    case 'float16':
      return floatOf(Number(value), FLOAT16_DIGITS, f16round);
    case 'date':
      return dateOf(Number(value)) ?? String(value);
    case 'time':
      return timeOf(BigInt(value), logical.unit, logical.utc);
    case 'timestamp':
      return timestampOf(BigInt(value), logical.unit, logical.utc);
    default:
      return physical === 'FLOAT'
        ? floatOf(Number(value), FLOAT32_DIGITS, Math.fround)
        : String(value);
  }
}

/**
 * A `count` of `unit` since 1970-01-01T00:00 in ISO 8601, ending in Z where
 * it counts from UTC. One past what a Date holds is written as its count.
 */
function timestampOf(count: bigint, unit: TimeUnit, utc: boolean): string {
  const perDay = ticksPerDay(unit);
  const sinceMidnight = ((count % perDay) + perDay) % perDay;
  const date = dateOf(Number((count - sinceMidnight) / perDay));
  if (date === undefined) return String(count);
  return `${date}T${clockOf(sinceMidnight, unit)}${utc ? 'Z' : ''}`;
}

/**
 * A `count` of `unit` since midnight as a clock, ending in Z where it is
 * UTC. One outside a day is written as its count, since no clock reads it.
 */
function timeOf(count: bigint, unit: TimeUnit, utc: boolean): string {
  if (count < 0n || count >= ticksPerDay(unit)) return String(count);
  return `${clockOf(count, unit)}${utc ? 'Z' : ''}`;
}

/** Days since 1970-01-01 as YYYY-MM-DD, or undefined past what a Date holds. */
function dateOf(days: number): string | undefined {
  const date = new Date(days * MILLIS_PER_DAY);
  if (Number.isNaN(date.getTime())) return undefined;
  const iso = date.toISOString();
  return iso.slice(0, iso.indexOf('T'));
}

/**
 * A `count` of `unit` inside one day as HH:MM:SS, with the fraction at the
 * unit's every digit where it is not zero.
 */
function clockOf(count: bigint, unit: TimeUnit): string {
  const perSecond = ticksPerSecond(unit);
  const seconds = count / perSecond;
  const fraction = count % perSecond;
  const clock = [
    seconds / SECONDS_PER_HOUR,
    (seconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR,
    seconds % SECONDS_PER_MINUTE,
  ]
    .map((part) => String(part).padStart(CLOCK_DIGITS, '0'))
    .join(':');
  if (fraction === 0n) return clock;
  return `${clock}.${String(fraction).padStart(FRACTION_DIGITS[unit], '0')}`;
}

/** How many of `unit` make one second. */
function ticksPerSecond(unit: TimeUnit): bigint {
  return DECIMAL_RADIX ** BigInt(FRACTION_DIGITS[unit]);
}

/** How many of `unit` make one day. */
function ticksPerDay(unit: TimeUnit): bigint {
  return SECONDS_PER_DAY * ticksPerSecond(unit);
}

/**
 * Stored bytes: a decimal's unscaled integer, a UUID in canonical form, or
 * else UTF-8 or 0x-hex.
 */
function bytesOf(logical: Logical | undefined, bytes: Uint8Array): string {
  if (logical?.t === 'decimal') {
    return decimalOf(signedOf(bytes), logical.scale);
  }
  if (logical?.t === 'uuid') {
    return bytes.length === UUID_BYTES ? uuidOf(bytes) : `0x${hexOf(bytes)}`;
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    return `0x${hexOf(bytes)}`;
  }
}

/** An unscaled integer as a decimal with every one of its scale's digits. */
function decimalOf(unscaled: bigint, scale: number): string {
  const sign = unscaled < 0n ? '-' : '';
  const digits = String(unscaled < 0n ? -unscaled : unscaled);
  const padded = digits.padStart(scale + 1, '0');
  const point = padded.length - scale;
  const fraction = scale > 0 ? `.${padded.slice(point)}` : '';
  return `${sign}${padded.slice(0, point)}${fraction}`;
}

/** Big-endian two's complement bytes as the integer they hold. */
function signedOf(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << BigInt(BYTE_BITS)) | BigInt(byte);
  }
  return BigInt.asIntN(bytes.length * BYTE_BITS, value);
}

/**
 * The shortest text that `round`, a float format's rounding, maps back to
 * `value`, with at most `digits` significant digits.
 */
function floatOf(
  value: number,
  digits: number,
  round: (x: number) => number,
): string {
  if (!Number.isFinite(value)) return String(value);
  for (let precision = 1; precision < digits; precision++) {
    const text = value.toPrecision(precision);
    if (round(Number(text)) === value) return String(Number(text));
  }
  return String(Number(value.toPrecision(digits)));
}

/**
 * The float16 nearest `x`, ties to even, as Math.f16round finds it. Node
 * before 24 has no Math.f16round, and the core's es2023 lib does not declare
 * it.
 */
function f16round(x: number): number {
  const magnitude = Math.abs(x);
  if (!Number.isFinite(x) || magnitude === 0) return x;
  const exponent = Math.max(
    Math.floor(Math.log2(magnitude)),
    FLOAT16_MIN_EXPONENT,
  );
  const step = 2 ** (exponent - FLOAT16_FRACTION_BITS);
  const below = Math.floor(magnitude / step);
  const over = magnitude / step - below;
  const up = over > 0.5 || (over === 0.5 && below % 2 === 1);
  const rounded = (up ? below + 1 : below) * step;
  return Math.sign(x) * (rounded > FLOAT16_MAX ? Infinity : rounded);
}

/** A UUID's bytes as lower-case hex in its five dashed groups. */
function uuidOf(bytes: Uint8Array): string {
  const hex = hexOf(bytes);
  const groups: string[] = [];
  let start = 0;
  for (const digits of UUID_GROUP_DIGITS) {
    groups.push(hex.slice(start, start + digits));
    start += digits;
  }
  return groups.join('-');
}

/** Bytes as lower-case hex, two digits each. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX).padStart(HEX_BYTE_DIGITS, '0'),
  ).join('');
}
