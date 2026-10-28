/**
 * @fileoverview Reads one JSON Lines record as the cells it holds.
 *
 * walkLine is a strict RFC 8259 tokenizer. A line it accepts is one JSON
 * object, and a line it refuses costs no throw. It keeps each number as
 * written, so 12345678901234567890 and 1.10 come back as they were.
 */

/** RFC 8259's number: an optional minus, digits, a fraction, an exponent. */
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
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
/**
 * Each word JSON writes, with its cell: true and false as they are, and null
 * as an empty cell.
 */
const WORDS: ReadonlyMap<string, string> = new Map([
  ['true', 'true'],
  ['false', 'false'],
  ['null', ''],
]);
/** RFC 8259's whitespace, which may come before and after any token. */
const BLANKS: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r']);
/** The bracket that closes an array or an object, by the one that opens it. */
const CLOSES: ReadonlyMap<string, string> = new Map([
  ['[', ']'],
  ['{', '}'],
]);
/** The cell of an empty object, which has no members to flatten. */
const EMPTY_OBJECT = '{}';

/**
 * How deep objects and arrays may nest in a line, the line's own object
 * counted. JSON.parse has no such limit, but walkLine reads each level a call
 * deeper, so it refuses a deeper line rather than overflow the stack.
 */
export const DEPTH_LIMIT = 256;

/** A member's value: the text of its cell, or an object's members. */
type Member = string | Members;
/** An object's members by name, where the last of a repeated name wins. */
type Members = Map<string, Member>;

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
    this.skip();
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

  /**
   * list reads a list nested `depth` levels inside the line's own object:
   * `open`, the items `item` reads, separated by commas, and `close`. It says
   * whether the whole list read, and refuses one nested deeper than
   * DEPTH_LIMIT allows.
   */
  list(
    open: string,
    close: string,
    depth: number,
    item: () => boolean,
  ): boolean {
    if (depth === DEPTH_LIMIT || !this.eat(open)) return false;
    if (this.eat(close)) return true;
    do {
      if (!item()) return false;
    } while (this.eat(','));
    return this.eat(close);
  }

  /**
   * cell reads a value other than an object, nested `depth` levels inside the
   * line's own object, and returns its cell. An array's cell is the array
   * minified.
   */
  cell(depth: number): string | undefined {
    return this.peek() === '[' ? this.minified(depth) : this.scalar();
  }

  /**
   * minified reads a value nested `depth` levels inside the line's own object
   * and returns it as written, less the whitespace between its tokens.
   */
  private minified(depth: number): string | undefined {
    const open = this.peek();
    const close = CLOSES.get(open);
    if (close === undefined) return this.written();
    const items: string[] = [];
    const read = this.list(open, close, depth, () => {
      const item =
        open === '{'
          ? this.minifiedMember(depth + 1)
          : this.minified(depth + 1);
      if (item === undefined) return false;
      items.push(item);
      return true;
    });
    return read ? `${open}${items.join(',')}${close}` : undefined;
  }

  /**
   * minifiedMember reads an object's member whose value is nested `depth`
   * levels inside the line's own object, and returns it as written, less the
   * whitespace between its tokens.
   */
  private minifiedMember(depth: number): string | undefined {
    const name = this.quoted();
    if (name === undefined || !this.eat(':')) return undefined;
    const value = this.minified(depth);
    return value === undefined ? undefined : `${name}:${value}`;
  }

  /** written reads a string, a number or a word and returns it as written. */
  private written(): string | undefined {
    return this.peek() === '"' ? this.quoted() : this.literal();
  }

  /** quoted reads a string and returns it as written, quotes included. */
  private quoted(): string | undefined {
    this.skip();
    const from = this.at;
    if (this.string() === undefined) return undefined;
    return this.line.slice(from, this.at);
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

  /** scalar reads a string, a number or a word and returns its cell. */
  private scalar(): string | undefined {
    if (this.peek() === '"') return this.string();
    const literal = this.literal();
    return literal === undefined ? undefined : (WORDS.get(literal) ?? literal);
  }

  /** literal reads a number or a word and returns it as written. */
  private literal(): string | undefined {
    this.skip();
    const from = this.at;
    if (this.match(NUMBER)) return this.line.slice(from, this.at);
    for (const word of WORDS.keys()) {
      if (this.line.startsWith(word, from)) {
        this.at += word.length;
        return word;
      }
    }
    return undefined;
  }

  /** skip advances past whitespace. */
  private skip(): void {
    while (BLANKS.has(this.line.charAt(this.at))) this.at++;
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
 * segmentsOf returns the names of the members RFC 6901 pointer `key` passes
 * through, each read back from how pointerTo writes it: /a~1b/m~0n passes
 * through a/b, then m~n. '~1' is read before '~0', so ~01 reads as ~1.
 */
export function segmentsOf(key: string): string[] {
  return key
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * membersOf reads an object nested `depth` levels inside the line's own and
 * returns its members, where the last of a repeated name wins in the place
 * the name first had. It returns undefined when what comes next is not an
 * object, or nests too deep.
 */
function membersOf(tokens: Tokens, depth: number): Members | undefined {
  const members: Members = new Map();
  const read = tokens.list('{', '}', depth, () => {
    const name = tokens.name();
    if (name === undefined) return false;
    const member =
      tokens.peek() === '{'
        ? membersOf(tokens, depth + 1)
        : tokens.cell(depth + 1);
    if (member === undefined) return false;
    members.set(name, member);
    return true;
  });
  return read ? members : undefined;
}

/**
 * flatten calls `leaf` with the pointer and the text of each cell under the
 * object `parent` points to. A nested object's members are cells in its
 * place, and an empty object is one cell.
 */
function flatten(
  parent: string,
  members: Members,
  leaf: (key: string, text: string) => void,
): void {
  for (const [name, member] of members) {
    const key = pointerTo(parent, name);
    if (typeof member === 'string') leaf(key, member);
    else if (member.size === 0) leaf(key, EMPTY_OBJECT);
    else flatten(key, member, leaf);
  }
}

/**
 * walkLine reads one JSON Lines record and calls `leaf` with each cell's
 * RFC 6901 pointer and text, where the last of a repeated name wins. A nested
 * object's members are cells of their own, so {"a":{"b":1}} has the cell /a/b,
 * and an empty object is the cell {}. An array is one cell, as written less
 * the whitespace between its tokens, so its numbers and escapes are as
 * written too. A string is unescaped, a number is as written, true and false
 * are words, and null is an empty cell. When the line is not one JSON object,
 * or nests deeper than DEPTH_LIMIT, walkLine reports nothing and returns
 * false. It never throws.
 */
export function walkLine(
  line: string,
  leaf: (key: string, text: string) => void,
): boolean {
  const tokens = new Tokens(line);
  const members = membersOf(tokens, 0);
  if (members === undefined || !tokens.end()) return false;
  flatten('', members, leaf);
  return true;
}
