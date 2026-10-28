/**
 * @fileoverview Reads one JSON Lines record as the cells it holds.
 *
 * walkLine is a strict RFC 8259 tokenizer. A line it accepts is one JSON
 * object, and a line it refuses costs no throw.
 */

/**
 * A run of what a string holds as written: all but '"', '\' and the controls
 * U+0000 to U+001F, which RFC 8259 writes only as escapes.
 */
// oxlint-disable-next-line no-control-regex -- the controls are what it leaves out.
const UNESCAPED = /[^"\\\x00-\x1f]*/y;
/** The four hex digits after '\u'. */
const HEX_DIGITS = /[0-9a-fA-F]{4}/y;
/** The base the digits after '\u' are written in. */
const HEX = 16;
/** What each escape but '\u' stands for, by the character after '\'. */
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);
/** RFC 8259's whitespace, which may come before and after any token. */
const BLANKS: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r']);

/**
 * Tokens reads RFC 8259's tokens from one line, in order, each past the
 * whitespace before it. A read that fails leaves the line in no useful place,
 * so its caller gives up on the line.
 */
class Tokens {
  /** Where the next read starts. */
  private at = 0;
  private readonly line: string;

  constructor(line: string) {
    this.line = line;
  }

  /** peek skips whitespace and returns the next character, '' at the end. */
  peek(): string {
    while (BLANKS.has(this.line.charAt(this.at))) this.at++;
    return this.line.charAt(this.at);
  }

  /** eat advances past `char` when it comes next, and says whether it did. */
  eat(char: string): boolean {
    if (this.peek() !== char) return false;
    this.at++;
    return true;
  }

  /** end says whether nothing but whitespace is left. */
  end(): boolean {
    return this.peek() === '';
  }

  /** name reads a member's name and the colon after it, and returns the name. */
  name(): string | undefined {
    const name = this.string();
    return name !== undefined && this.eat(':') ? name : undefined;
  }

  /** cell reads one value and returns the text of its cell. */
  cell(): string | undefined {
    return this.string();
  }

  /** string reads a string and returns it unescaped. */
  private string(): string | undefined {
    if (!this.eat('"')) return undefined;
    let text = '';
    for (;;) {
      const from = this.at;
      this.match(UNESCAPED);
      text += this.line.slice(from, this.at);
      const next = this.line.charAt(this.at++);
      if (next === '"') return text;
      const escaped = next === '\\' ? this.escape() : undefined;
      if (escaped === undefined) return undefined;
      text += escaped;
    }
  }

  /** escape reads an escape past its '\' and returns what it stands for. */
  private escape(): string | undefined {
    const kind = this.line.charAt(this.at++);
    if (kind !== 'u') return ESCAPES.get(kind);
    const from = this.at;
    if (!this.match(HEX_DIGITS)) return undefined;
    const code = Number.parseInt(this.line.slice(from, this.at), HEX);
    return String.fromCharCode(code);
  }

  /** match advances past `pattern` when it matches here. */
  private match(pattern: RegExp): boolean {
    pattern.lastIndex = this.at;
    if (!pattern.test(this.line)) return false;
    this.at = pattern.lastIndex;
    return true;
  }
}

/**
 * pointerTo returns the RFC 6901 pointer to member `name` of what `parent`
 * points to. A '~' in the name is written '~0', and a '/' is written '~1'.
 */
function pointerTo(parent: string, name: string): string {
  return `${parent}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

/**
 * membersOf reads a line that holds one object and returns each member's
 * cell by name, where the last of a repeated name wins. It returns undefined
 * when the line holds anything else.
 */
function membersOf(tokens: Tokens): Map<string, string> | undefined {
  const members = new Map<string, string>();
  if (!tokens.eat('{')) return undefined;
  if (tokens.eat('}')) return tokens.end() ? members : undefined;
  for (;;) {
    const name = tokens.name();
    if (name === undefined) return undefined;
    const cell = tokens.cell();
    if (cell === undefined) return undefined;
    members.set(name, cell);
    if (tokens.eat(',')) continue;
    return tokens.eat('}') && tokens.end() ? members : undefined;
  }
}

/**
 * walkLine reads one JSON Lines record and calls `leaf` with each member's
 * RFC 6901 pointer and the text of its cell, where the last of a repeated name
 * wins. A member's cell is its string, unescaped. walkLine reads no other kind
 * of value yet, and refuses a line that holds one. When the line is not one
 * JSON object, walkLine reports nothing and returns false. It never throws.
 */
export function walkLine(
  line: string,
  leaf: (key: string, text: string) => void,
): boolean {
  const members = membersOf(new Tokens(line));
  if (members === undefined) return false;
  for (const [name, cell] of members) leaf(pointerTo('', name), cell);
  return true;
}
