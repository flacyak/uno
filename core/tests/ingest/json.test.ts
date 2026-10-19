/**
 * @fileoverview walkLine reads a JSON line as the cells it holds, and refuses
 * anything but one object without a throw.
 */

import { describe, expect, test } from 'vite-plus/test';

import { DEPTH_LIMIT, walkLine } from '@ingest/json';

/** How deep a line nests that would overflow the stack if walkLine read it. */
const PAST_THE_STACK = 100_000;

/**
 * walked returns the leaves walkLine reports for `line`, or false when it
 * refuses the line, which it must do having reported nothing.
 */
function walked(line: string): Array<[string, string]> | false {
  const leaves: Array<[string, string]> = [];
  const read = walkLine(line, (key, text) => leaves.push([key, text]));
  if (!read) expect(leaves, `reported, then refused: ${line}`).toEqual([]);
  return read && leaves;
}

/** nested returns a line of `depth` objects, each the one member of the last. */
function nested(depth: number): string {
  const around = depth - 1;
  return `${'{"a":'.repeat(around)}{}${'}'.repeat(around)}`;
}

/** arraysIn returns the array of a line nested `depth` deep in arrays. */
function arraysIn(depth: number): string {
  const arrays = depth - 1;
  return `${'['.repeat(arrays)}${']'.repeat(arrays)}`;
}

describe('walkLine', () => {
  const read: Array<[string, string, Array<[string, string]>]> = [
    [
      'a string is a cell of what it holds, characters past ASCII included',
      '{"s":"x y","e":"","u":"日😀"}',
      [
        ['/s', 'x y'],
        ['/e', ''],
        ['/u', '日😀'],
      ],
    ],
    [
      "'~' and '/' in a name are written '~0' and '~1'",
      '{"a/b":"w","m~n":"x","~1":"y","":"z"}',
      [
        ['/a~1b', 'w'],
        ['/m~0n', 'x'],
        ['/~01', 'y'],
        ['/', 'z'],
      ],
    ],
    [
      'the last of a repeated name wins, in the place the name first had',
      String.raw`{"a":"x","b":"y","\u0061":"z"}`,
      [
        ['/a', 'z'],
        ['/b', 'y'],
      ],
    ],
    [
      'whitespace may come around every token',
      ' \t{ "a" : "x" , "b":"y" }\r\n',
      [
        ['/a', 'x'],
        ['/b', 'y'],
      ],
    ],
    ['an empty object has no leaves', '{ }', []],
    [
      "a nested object's members are cells named by the path to them",
      '{"a":{"b":"x","c":{"d":1}},"e":2}',
      [
        ['/a/b', 'x'],
        ['/a/c/d', '1'],
        ['/e', '2'],
      ],
    ],
    [
      "a literal 'a.b' and nested a then b are different cells",
      '{"a.b":"x","a":{"b":"y"}}',
      [
        ['/a.b', 'x'],
        ['/a/b', 'y'],
      ],
    ],
    [
      'a nested empty object is one cell',
      '{"a":{ },"b":{"c":{}}}',
      [
        ['/a', '{}'],
        ['/b/c', '{}'],
      ],
    ],
    [
      "a repeated name's last value replaces the whole of the first",
      '{"a":{"b":"x"},"c":{"d":"y"},"e":"z","a":{"f":1},"c":2,"e":{"g":3}}',
      [
        ['/a/f', '1'],
        ['/c', '2'],
        ['/e/g', '3'],
      ],
    ],
    [
      'an array is one cell, minified, with its numbers and escapes as written',
      String.raw`{"a":[ 1.10 , "\u0041 \n" , { "b" : [ ] , "b" : null } , true ],"e":[ ]}`,
      [
        ['/a', String.raw`[1.10,"\u0041 \n",{"b":[],"b":null},true]`],
        ['/e', '[]'],
      ],
    ],
    [
      'the last of a repeated name wins inside a nested object too',
      '{"a":{"b":"x","b":"y"}}',
      [['/a/b', 'y']],
    ],
    [
      'strings are unescaped',
      String.raw`{"s":"q\" b\\ s\/ \b\f\n\r\t"}`,
      [['/s', 'q" b\\ s/ \b\f\n\r\t']],
    ],
    [
      'a \\u escape is one UTF-16 unit, so a pair makes one character',
      String.raw`{"e":"\u00e9","pair":"\ud83d\uDE00","lone":"\udc00"}`,
      [
        ['/e', 'é'],
        ['/pair', '😀'],
        ['/lone', '\udc00'],
      ],
    ],
    [
      'numbers come back as written',
      '{"big":12345678901234567890,"scale":1.10,"e":-1.5E+10,"zero":-0}',
      [
        ['/big', '12345678901234567890'],
        ['/scale', '1.10'],
        ['/e', '-1.5E+10'],
        ['/zero', '-0'],
      ],
    ],
    [
      'true and false are words, and null is an empty cell',
      '{"t":true,"f":false,"n":null}',
      [
        ['/t', 'true'],
        ['/f', 'false'],
        ['/n', ''],
      ],
    ],
  ];

  for (const [name, line, leaves] of read) {
    test(name, () => expect(walked(line)).toEqual(leaves));
  }

  const refused: Array<[string, string]> = [
    ['an empty line', ''],
    ['a truncated object', '{"a":"x"'],
    ['a truncated string', '{"a":"x'],
    ['a truncated escape', String.raw`{"a":"\u00"}`],
    ['an unknown escape', String.raw`{"a":"\x41"}`],
    ['a bare string', '"x"'],
    ['a bare number', '12'],
    ['an array', '[{"a":"x"}]'],
    ['two objects', '{} {}'],
    ['a trailing comma', '{"a":"x",}'],
    ['a missing colon', '{"a" "x"}'],
    ['a raw control character in a string', '{"a":"x\ty"}'],
    ['a byte order mark, which JSON.parse refuses too', '\u{feff}{}'],
    ['a number with a leading zero', '{"a":01}'],
    ['a number with no digits after its point', '{"a":1.}'],
    ['a word cut short', '{"a":tru}'],
    ['an array cut short', '{"a":[1,2}'],
    ['a trailing comma in an array', '{"a":[1,]}'],
    ['a name in an array that is not a string', '{"a":[{1:2}]}'],
    ['a missing colon in an array', '{"a":[{"b" 1}]}'],
    ['an unknown escape in an array', String.raw`{"a":["\x41"]}`],
  ];

  for (const [name, line] of refused) {
    test(`refuses ${name}, reporting nothing`, () =>
      expect(walked(line)).toBe(false));
  }

  test('reads a line nested DEPTH_LIMIT deep', () => {
    expect(walked(nested(DEPTH_LIMIT))).toEqual([
      ['/a'.repeat(DEPTH_LIMIT - 1), '{}'],
    ]);
    const arrays = arraysIn(DEPTH_LIMIT);
    expect(walked(`{"a":${arrays}}`)).toEqual([['/a', arrays]]);
  });

  test('refuses a line nested deeper, rather than overflow the stack', () => {
    expect(walked(nested(DEPTH_LIMIT + 1))).toBe(false);
    expect(walked(nested(PAST_THE_STACK))).toBe(false);
    expect(walked(`{"a":${arraysIn(DEPTH_LIMIT + 1)}}`)).toBe(false);
    expect(walked(`{"a":${arraysIn(PAST_THE_STACK)}}`)).toBe(false);
  });
});
