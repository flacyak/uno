/**
 * @fileoverview The IAM documents a connection asks for, each beside a Copy
 * button: the permission policy the keys that sign in need, and for the
 * hosted engine's role sign-in, uno's account, the external ID and the trust
 * policy the role is made with.
 *
 * The documents are written by `trustPolicy` and `permissionPolicy` in
 * @uno/grid, and the permission policy follows the bucket and prefix as they
 * are typed, so what is copied is what the connection will ask for. The form
 * edits none of it: a policy is attached where the bucket is managed, by the
 * team or the system that owns it.
 *
 * It is a block of its own, mounted by the connect form. With a role as the
 * sign-in it shows once the engine has said what the role has to trust. With
 * a profile or the machine's keys it shows the permission policy alone, once
 * a bucket is named. The desktop and the web page both draw it through the
 * renderer.
 */

import type { Trust } from "@engine";
import { accountOf, permissionPolicy, trustPolicy } from "@library";

import { m } from "@paraglide/messages";
import { Words, el } from "./util.ts";

/** The bucket and folder the permission policy is written for, as the form reads them. */
export interface Place {
  bucket: string;
  /** "" for the whole bucket, and otherwise ending in a slash. */
  prefix: string;
}

/** How long a copy button says it copied before it offers to copy again. */
const COPIED_MS = 1500;

/** writeClipboard is the page's clipboard. Refused by the browser at times. */
function writeClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export class PolicyBlock {
  readonly el = el("div", "policy");
  private readonly words = new Words();
  private readonly account = el("code", "copyable");
  private readonly externalId = el("code", "copyable");
  private readonly trust = el("pre", "copyable document");
  private readonly permission = el("pre", "copyable document");
  /** The rows a role sign-in alone has: the account, the external ID and the trust policy. */
  private readonly roleRows: HTMLElement[];
  /** The permission policy's row, which waits for a bucket to be named. */
  private readonly permissionRow: HTMLElement;
  /** Whether the block is drawn for a role, which the note under the rows follows. */
  private forRole = false;

  constructor(private readonly copy: (text: string) => Promise<void> = writeClipboard) {
    const block = this.el;
    block.hidden = true;
    this.roleRows = [
      this.row(m.role_account, this.account),
      this.row(m.role_external_id, this.externalId),
      this.row(m.role_trust_policy, this.trust),
    ];
    this.permissionRow = this.row(m.role_permission_policy, this.permission);
    block.append(
      ...this.roleRows,
      this.permissionRow,
      this.words.text(el("div", "how"), () => (this.forRole ? m.role_how() : m.policy_keys_how())),
    );
  }

  /**
   * show draws the block for `place`: the permission policy, and with
   * `trust` the role's account, external ID and trust policy before it.
   */
  show(place: Place, trust?: Trust): void {
    this.forRole = trust !== undefined;
    for (const row of this.roleRows) row.hidden = trust === undefined;
    if (trust !== undefined) {
      // The account alone when the ARN has one, as the console asks for it,
      // and the whole principal otherwise.
      this.account.textContent = accountOf(trust.principal) ?? trust.principal;
      this.externalId.textContent = trust.externalId;
      this.trust.textContent = trustPolicy(trust);
    }
    // The permission policy names the bucket, so there is none to copy
    // before one is typed.
    this.permissionRow.hidden = place.bucket === "";
    this.permission.textContent = permissionPolicy(place);
    this.words.write();
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
