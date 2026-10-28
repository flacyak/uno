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
 * ParquetValue is one value of a column as hyparquet reads it with identity
 * parsers, so a string or binary is its bytes.
 */
export type ParquetValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Uint8Array;

/** The significant digits that write any float32 so it reads back exactly. */
export const FLOAT32_DIGITS = 9;

/** The bits an INT32 and an INT64 hold, read as unsigned where annotated. */
const INT32_BITS = 32;
const INT64_BITS = 64;

/** The radix and width of one byte in 0x-hex. */
const HEX = 16;
const HEX_BYTE_DIGITS = 2;

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
 * exact, at its own precision, and a null is an empty cell.
 */
export function textOf({ shape }: Leaf, value: ParquetValue): string {
  return scalarOf(shape.t === 'primitive' ? shape : undefined, value);
}

/** A value by what its primitive says it means, or as it is with none. */
function scalarOf(
  primitive: Primitive | undefined,
  value: ParquetValue,
): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return bytesOf(value);
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
    case 'unsigned': {
      const bits = physical === 'INT64' ? INT64_BITS : INT32_BITS;
      return String(BigInt.asUintN(bits, BigInt(value)));
    }
    default:
      return physical === 'FLOAT'
        ? floatOf(Number(value), FLOAT32_DIGITS, Math.fround)
        : String(value);
  }
}

/** Stored bytes as UTF-8 where they decode cleanly, and 0x-hex otherwise. */
function bytesOf(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return `0x${hexOf(bytes)}`;
  }
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

/** Bytes as lower-case hex, two digits each. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX).padStart(HEX_BYTE_DIGITS, '0'),
  ).join('');
}
