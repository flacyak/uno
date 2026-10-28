/**
 * @fileoverview Parquet values as the text their writer meant. columnsOf
 * reads a footer's schema as the columns a sheet shows.
 *
 * Nothing here imports hyparquet. Its schema elements fit Element as they
 * are.
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

/** Primitive is the type of one stored value. */
export interface Primitive {
  readonly t: 'primitive';
  readonly physical: Physical;
}

/**
 * Shape is the type of a column's values: a primitive, or a list or struct
 * of further shapes, which is written as JSON.
 */
export type Shape =
  | Primitive
  | { readonly t: 'list'; readonly of: Shape }
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

/**
 * Element is one element of a footer's schema, as hyparquet's SchemaElement
 * holds it. The schema lists a group's children after it, depth first.
 */
export interface Element {
  readonly name: string;
  readonly type?: Physical;
  readonly repetition_type?: 'REQUIRED' | 'OPTIONAL' | 'REPEATED';
  readonly num_children?: number;
}

/** A schema element with its children. */
interface Tree {
  readonly element: Element;
  readonly children: readonly Tree[];
}

/**
 * columnsOf reads a footer's schema as the file's columns, in schema order.
 * A struct's fields flatten to dotted names, and a repeated field is one
 * column. A name already taken gets headerOf's suffix.
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
    node.children.length > 0 && node.element.repetition_type !== 'REPEATED'
  );
}

/** The shape of a node's values. A repeated node holds a list of them. */
function shapeOf(node: Tree): Shape {
  const shape = valueShapeOf(node);
  return node.element.repetition_type === 'REPEATED'
    ? { t: 'list', of: shape }
    : shape;
}

/** The shape of one value of a node. */
function valueShapeOf({ element, children }: Tree): Shape {
  if (children.length === 0) return primitiveOf(element);
  return {
    t: 'struct',
    fields: new Map(
      children.map((child) => [child.element.name, shapeOf(child)]),
    ),
  };
}

/** The primitive a leaf element stores. */
function primitiveOf(element: Element): Primitive {
  if (element.type === undefined) {
    throw new Error(`parquet column ${element.name} has no type`);
  }
  return { t: 'primitive', physical: element.type };
}
