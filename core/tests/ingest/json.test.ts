/**
 * @fileoverview walkLine reads a JSON line as the cells it holds, and refuses
 * anything but one object without a throw.
 */

import { describe, expect, test } from 'vite-plus/test';

import { walkLine } from '@ingest/json';

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
      '{"a":"x","b":"y","a":"z"}',
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
  ];

  for (const [name, line, leaves] of read) {
    test(name, () => expect(walked(line)).toEqual(leaves));
  }

  const refused: Array<[string, string]> = [
    ['an empty line', ''],
    ['a truncated object', '{"a":"x"'],
    ['a truncated string', '{"a":"x'],
    ['a bare string', '"x"'],
    ['an array', '[{"a":"x"}]'],
    ['two objects', '{} {}'],
    ['a trailing comma', '{"a":"x",}'],
    ['a missing colon', '{"a" "x"}'],
    ['a raw control character in a string', '{"a":"x\ty"}'],
    ['a byte order mark, which JSON.parse refuses too', '\u{feff}{}'],
  ];

  for (const [name, line] of refused) {
    test(`refuses ${name}, reporting nothing`, () =>
      expect(walked(line)).toBe(false));
  }
});
