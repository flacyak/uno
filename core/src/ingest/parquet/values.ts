/**
 * @fileoverview Parquet values as the text their writer meant. columnsOf
 * reads a footer's schema as the columns a sheet shows.
 *
 * Nothing here imports hyparquet. Its schema elements fit Element as they
 * are.
 */

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
 * Column is a leaf as a sheet shows it: a name unique in its file, and the
 * leaf's field path as an RFC 6901 pointer.
 */
export interface Column {
  readonly name: string;
  readonly key: string;
}

/** Leaf is one column of a Parquet file. */
export interface Leaf {
  readonly column: Column;
  /** The field names from the top of the schema down to this column. */
  readonly path: readonly string[];
  readonly shape: Primitive;
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

/** columnsOf reads a footer's schema as the file's columns, in schema order. */
export function columnsOf(schema: readonly Element[]): Leaf[] {
  return treeOf(schema).children.map(({ element }) => {
    const path = [element.name];
    return {
      column: { name: element.name, key: pointerOf(path) },
      path,
      shape: primitiveOf(element),
    };
  });
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

/** The primitive a leaf element stores. */
function primitiveOf(element: Element): Primitive {
  if (element.type === undefined) {
    throw new Error(`parquet column ${element.name} has no type`);
  }
  return { t: 'primitive', physical: element.type };
}
