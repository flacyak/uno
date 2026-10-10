// A cursor over an array of runes, shared by the hand-written parsers. It
// skips space, accepts one rune, expects one, and reports where it was when
// the expected rune is missing.

import { quote } from "./strconv.ts";
import { isSpace } from "./strings.ts";

export class Scanner {
  i = 0;
  readonly s: string[];
  /** What the text is called in an error: "formula" or "program". */
  protected readonly noun: string;

  // Plain fields assigned in the body: Node's strip-only TypeScript rejects
  // parameter properties, and the smoke run loads this source under it.
  constructor(s: string[], noun: string) {
    this.s = s;
    this.noun = noun;
  }

  space(): void {
    while (this.i < this.s.length && isSpace(this.s[this.i]!)) this.i++;
  }

  accept(r: string): boolean {
    this.space();
    if (this.i < this.s.length && this.s[this.i] === r) {
      this.i++;
      return true;
    }
    return false;
  }

  expect(r: string): void {
    if (this.accept(r)) return;
    throw new Error(`expected ${quote(r)} at character ${this.i + 1}, ${this.here()}`);
  }

  /** here describes the text at the cursor, for an error message. */
  here(): string {
    if (this.i >= this.s.length) return `and the ${this.noun} ends there`;
    const ahead = this.s.slice(this.i, Math.min(this.i + 8, this.s.length)).join("");
    return `found ${quote(ahead)}`;
  }

  /**
   * whole runs `grammar` over the text, then refuses any unread remainder.
   * Any error is rethrown naming `src`.
   */
  whole<T>(src: string, grammar: () => T): T {
    const out = this.about(src, grammar);
    this.space();
    if (this.i < this.s.length) {
      this.refuse(src, `unexpected ${quote(this.s[this.i]!)} at character ${this.i + 1}`);
    }
    return out;
  }

  /** refuse throws an error naming the text and the reason. */
  refuse(src: string, why: string): never {
    throw new Error(`${this.noun} ${quote(src)}: ${why}`);
  }

  private about<T>(src: string, grammar: () => T): T {
    try {
      return grammar();
    } catch (err) {
      return this.refuse(src, (err as Error).message);
    }
  }
}
