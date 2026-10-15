/**
 * @fileoverview Random JSON Lines records for the test that holds walkLine to
 * JSON.parse: objects written with random whitespace, escapes, numbers and
 * repeated names.
 */

import type { Random } from './random.ts';

/** How deep a random line's values nest below its own object, at most. */
const DEEPEST = 4;
/** The most members or items a random object or array holds. */
const WIDEST = 4;
/** The most of CHARACTERS a random string holds. */
const LONGEST_STRING = 6;
/** The most digits after the first in a run, past where a double is exact. */
const MOST_DIGITS = 22;
/** Chance a character a string may hold raw is written as an escape. */
const ESCAPE_CHANCE = 0.3;
/** The first character a string may hold raw. */
const FIRST_RAW = 0x20;
/** The base a \u escape is written in. */
const HEX = 16;
/** How many hex digits a \u escape holds. */
const HEX_WIDTH = 4;

/** Names a member takes, few enough that a name often repeats. */
const NAMES = [
  'a',
  'b',
  'a.b',
  '~',
  '/',
  '~1',
  '',
  '0',
  '10',
  'é',
  '__proto__',
];
/** Characters a string holds, those that must be escaped included. */
const CHARACTERS = [
  'a',
  ' ',
  'é',
  '日',
  '😀',
  '\ud800',
  '\x7f',
  '"',
  '\\',
  '/',
  '\b',
  '\f',
  '\n',
  '\r',
  '\t',
  '\0',
  '\x1f',
];
/** Whitespace between tokens, none most often. */
const BLANKS = ['', '', '', ' ', '\t', '\n', '\r', ' \r\n'];
/** The digits. */
const DIGITS = '0123456789'.split('');
/** The digits a number's whole part starts with when it is not 0. */
const NONZERO = '123456789'.split('');
/** The two-character escape of each character that has one. */
const SHORT_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '\\"'],
  ['\\', '\\\\'],
  ['/', '\\/'],
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/** pick returns one of `from`, each as likely. */
function pick<T>(rand: Random, from: readonly T[]): T {
  return from[Math.floor(rand() * from.length)]!;
}

/** upTo returns a whole number from 0 to `most`. */
function upTo(rand: Random, most: number): number {
  return Math.floor(rand() * (most + 1));
}

/** run returns a run of digits, one or more, `first` drawn from. */
function run(rand: Random, first: readonly string[]): string {
  const rest = Array.from({ length: upTo(rand, MOST_DIGITS) }, () =>
    pick(rand, DIGITS),
  );
  return pick(rand, first) + rest.join('');
}

/** number returns a number as RFC 8259 writes one, in any of its forms. */
function number(rand: Random): string {
  const sign = pick(rand, ['', '-']);
  const whole = pick(rand, ['0', run(rand, NONZERO)]);
  const fraction = pick(rand, ['', `.${run(rand, DIGITS)}`]);
  const mark = pick(rand, ['e', 'E']) + pick(rand, ['', '+', '-']);
  const exponent = pick(rand, ['', mark + run(rand, DIGITS)]);
  return sign + whole + fraction + exponent;
}

/** escaped returns one UTF-16 unit as a string writes it: raw, or escaped. */
function escaped(rand: Random, unit: string): string {
  const raw = unit !== '"' && unit !== '\\' && unit.charCodeAt(0) >= FIRST_RAW;
  if (raw && rand() >= ESCAPE_CHANCE) return unit;
  const hex = unit.charCodeAt(0).toString(HEX).padStart(HEX_WIDTH, '0');
  const long = `\\u${pick(rand, [hex, hex.toUpperCase()])}`;
  return pick(rand, [long, SHORT_ESCAPES.get(unit) ?? long]);
}

/**
 * quoted returns `text` as a string, each UTF-16 unit raw or escaped, so a
 * pair may be written half raw and half escaped.
 */
function quoted(rand: Random, text: string): string {
  const units = text.split('').map((unit) => escaped(rand, unit));
  return `"${units.join('')}"`;
}

/** spaced returns `token` with random whitespace around it. */
function spaced(rand: Random, token: string): string {
  return pick(rand, BLANKS) + token + pick(rand, BLANKS);
}

/** content returns a random string's text: up to LONGEST_STRING CHARACTERS. */
function content(rand: Random): string {
  const length = upTo(rand, LONGEST_STRING);
  return Array.from({ length }, () => pick(rand, CHARACTERS)).join('');
}

/** value returns a random value, nested `depth` levels below the line's. */
function value(rand: Random, depth: number): string {
  const kinds = [
    () => quoted(rand, content(rand)),
    () => number(rand),
    () => pick(rand, ['true', 'false', 'null']),
  ];
  if (depth < DEEPEST) {
    kinds.push(
      () => object(rand, depth + 1),
      () => array(rand, depth + 1),
    );
  }
  return pick(rand, kinds)();
}

/** object returns a random object, its names drawn from NAMES. */
function object(rand: Random, depth: number): string {
  const members = Array.from({ length: upTo(rand, WIDEST) }, () => {
    const name = spaced(rand, quoted(rand, pick(rand, NAMES)));
    return `${name}:${spaced(rand, value(rand, depth))}`;
  });
  return `{${members.join(',') || pick(rand, BLANKS)}}`;
}

/** array returns a random array. */
function array(rand: Random, depth: number): string {
  const items = Array.from({ length: upTo(rand, WIDEST) }, () =>
    spaced(rand, value(rand, depth)),
  );
  return `[${items.join(',') || pick(rand, BLANKS)}]`;
}

/**
 * jsonish returns a random JSON Lines record: one object, written with
 * random whitespace, escapes and number forms.
 */
export function jsonish(rand: Random): string {
  return spaced(rand, object(rand, 0));
}
