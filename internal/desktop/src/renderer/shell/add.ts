// What the + at the end of the tab strip offers: a file off this machine, or an
// object in S3.
//
// It hangs off the page rather than the strip, because the strip is drawn again
// on every edit and would take an open menu down with it.

import "./add.css";

import type { SourceRef } from "@uno/grid/engine";
import { s3Location, s3Url } from "@uno/grid/store/s3";

/** What choosing an item does. The shell decides; the menu only asks. */
export interface AddActions {
  /** Ask for files on this machine, as Ctrl+Shift+O does. */
  file(): void;
  /** Add the object at a URL that has already been read as one in S3. */
  remote(ref: SourceRef): void;
  /** The menu closed, so the keys go back to the grid. */
  closed(): void;
}

/**
 * remoteRef reads a pasted address as an S3 object, in the one form a .uno
 * writes down, or says what is wrong with it. The tab is named after the
 * object, the way a local file's tab is named after the file.
 */
export function remoteRef(typed: string): SourceRef | string {
  const loc = s3Location(typed);
  if (loc === undefined) return "not an S3 object · s3://bucket/key, or its https address";
  const name = loc.key.slice(loc.key.lastIndexOf("/") + 1);
  return { name, path: s3Url(loc) };
}

export class AddMenu {
  private readonly box = document.createElement("div");
  private readonly away = (e: MouseEvent): void => {
    if (!this.box.contains(e.target as Node)) this.close();
  };

  constructor(
    /** The + it opened from, so it can hang beneath it. */
    anchor: HTMLElement,
    private readonly act: AddActions,
  ) {
    this.box.className = "add-menu";
    const at = anchor.getBoundingClientRect();
    this.box.style.left = `${Math.round(at.left)}px`;
    this.box.style.top = `${Math.round(at.bottom)}px`;
    this.box.addEventListener("keydown", (e) => {
      // The grid's keys and the shell's chords stay out of what is typed here.
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });

    this.box.append(
      this.item("File…", "Ctrl+Shift+O", () => {
        this.close();
        this.act.file();
      }),
      this.item("S3 URL…", "", () => this.askUrl()),
    );
    document.body.append(this.box);
    // After this click has finished, or it would close the menu it opened.
    setTimeout(() => document.addEventListener("mousedown", this.away), 0);
  }

  close(): void {
    if (!this.box.isConnected) return;
    document.removeEventListener("mousedown", this.away);
    this.box.remove();
    this.act.closed();
  }

  private item(label: string, keys: string, choose: () => void): HTMLElement {
    const item = document.createElement("div");
    item.className = "add-item";
    item.append(label);
    if (keys !== "") {
      const k = document.createElement("span");
      k.className = "keys";
      k.textContent = keys;
      item.append(k);
    }
    item.addEventListener("click", choose);
    return item;
  }

  /**
   * askUrl turns the menu into the one question it has: which object. The
   * address is checked here, so a typo is answered before an engine is asked
   * to sign a request for it. Whether the object is there, and readable with
   * the credentials this machine has, only the engine can say.
   */
  private askUrl(): void {
    const input = document.createElement("input");
    input.className = "add-url";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = "s3://bucket/key.csv";
    input.setAttribute("aria-label", "S3 URL");

    const hint = document.createElement("div");
    hint.className = "add-hint";
    hint.textContent = "read with this machine's AWS credentials · Enter to add";

    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const ref = remoteRef(input.value);
      if (typeof ref === "string") {
        hint.textContent = ref;
        hint.classList.add("err");
        return;
      }
      this.close();
      this.act.remote(ref);
    });
    input.addEventListener("input", () => {
      hint.classList.remove("err");
      hint.textContent = "read with this machine's AWS credentials · Enter to add";
    });

    this.box.replaceChildren(input, hint);
    input.focus();
  }
}
