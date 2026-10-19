// What a person hands to whoever makes the role uno's hosted engine assumes:
// uno's account and their external ID, with what the role has to allow.
//
// The role is made where the bucket is managed, by the team or the system
// that owns it, so the form gives the two values to pass on and says what the
// role needs, and edits nothing of the policies. The documents themselves are
// written by `rolePolicies` in @uno/grid for whoever provisions the role.
//
// It is a block of its own, mounted by the connect form while a role is the
// sign-in and an engine has said what the role has to trust. The desktop and
// the web page both draw it through the renderer, and each engine decides
// whether it appears by what it offers in `SignIns`.

import type { Trust } from "#engine";
import { accountOf } from "#library";

import { m } from "#paraglide/messages";
import { Words, el } from "./util.ts";

/** How long a copy button says it copied before it offers to copy again. */
const COPIED_MS = 1500;

/** writeClipboard is the page's clipboard. Refused by the browser at times. */
function writeClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export class RoleBlock {
  readonly el = el("div", "role");
  private readonly words = new Words();
  private readonly account = el("code", "copyable");
  private readonly externalId = el("code", "copyable");

  constructor(private readonly copy: (text: string) => Promise<void> = writeClipboard) {
    const block = this.el;
    block.hidden = true;
    block.append(
      this.row(m.role_account, this.account),
      this.row(m.role_external_id, this.externalId),
      this.words.text(el("div", "how"), m.role_how),
      this.words.text(el("div", "needs"), m.role_needs),
    );
  }

  /** show draws the block for `trust`. */
  show(trust: Trust): void {
    // The account alone when the ARN has one, as the console asks for it, and
    // the whole principal otherwise.
    this.account.textContent = accountOf(trust.principal) ?? trust.principal;
    this.externalId.textContent = trust.externalId;
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  /** relabel rewrites the block's fixed text in the current language. */
  relabel(): void {
    this.words.write();
  }

  /** row is one labelled value: the label and its Copy button on one line, the value under them. */
  private row(label: () => string, value: HTMLElement): HTMLElement {
    const row = el("div", "row");
    row.append(
      this.words.text(el("span"), label),
      this.copyButton(label, () => value.textContent),
      value,
    );
    return row;
  }

  /**
   * copyButton copies what `text` reads when pressed and says so for a
   * moment. A copy the browser refuses leaves the label as it was; the text
   * beside it is selectable, so it can still be taken by hand.
   */
  private copyButton(what: () => string, text: () => string | null): HTMLButtonElement {
    const button = el("button", "copy");
    button.type = "button";
    this.words.text(button, m.action_copy);
    this.words.attr(button, "aria-label", () => m.role_copy_aria({ what: what() }));
    let back: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", () => {
      const value = text();
      if (value === null || value === "") return;
      void this.copy(value).then(
        () => {
          button.textContent = m.action_copied();
          clearTimeout(back);
          back = setTimeout(() => (button.textContent = m.action_copy()), COPIED_MS);
        },
        () => undefined,
      );
    });
    return button;
  }
}
