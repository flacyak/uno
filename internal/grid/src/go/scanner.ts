// A scanner over runes, which is how every hand-written parser here walks its
// text: as much of Go's text/scanner as three small grammars need.
//
// They are hand-written because each grammar is a few names deep and a
// generated parser would be a build step and a dependency for something
// smaller than the file describing it. What they share is here: the cursor,
// skipping space, taking one rune, insisting on one, and saying where it was
// when it could not.

import { quote } from "./strconv.ts";
import { isSpace } from "./strings.ts";

export class Scanner {
  i = 0;

  /** `noun` is what the text is called in a complaint: a formula, a program. */
  constructor(
    readonly s: string[],
    protected readonly noun: string,
  ) {}

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

  /** here names what was found instead, so an error points at the text rather
   * than only at an offset into it. */
  here(): string {
    if (this.i >= this.s.length) return `and the ${this.noun} ends there`;
    const ahead = this.s.slice(this.i, Math.min(this.i + 8, this.s.length)).join("");
    return `found ${quote(ahead)}`;
  }

  /**
   * whole runs the grammar over the text and refuses what it left unread, and
   * anything either refuses names the text, so what reaches a person says
   * which formula or program it was about.
   */
  whole<T>(src: string, grammar: () => T): T {
    const out = this.about(src, grammar);
    this.space();
    if (this.i < this.s.length) {
      this.refuse(src, `unexpected ${quote(this.s[this.i]!)} at character ${this.i + 1}`);
    }
    return out;
  }

  /** refuse is a complaint about the text, named. */
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
