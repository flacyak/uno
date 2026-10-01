// The text the page's own markup carries: the heads, the empty state, the
// switch between view and transform, and what the controls are called aloud.
//
// index.html holds the elements and none of their words. The compiler reads
// TypeScript and not HTML, so a word written there would stay in the language
// it was typed in. They are written here, when the shell starts and again
// whenever the language changes, along with the language and the direction the
// page says it is in, which a screen reader and a right-to-left script go by.

import { m } from "../../paraglide/messages.js";
import { getLocale, getTextDirection } from "../../paraglide/runtime.js";
import type { MessagePart } from "../../paraglide/runtime.js";
import { found, must } from "./util.ts";

/** labelPage writes the page's words in the language the app is in now. */
export function labelPage(): void {
  const root = document.documentElement;
  root.lang = getLocale();
  root.dir = getTextDirection();

  say(".sidebar-head", m.workspaces_title());
  say("#new .label", m.new_workspace());
  say("#empty h1", m.empty_title());
  link(found("#open"), m.empty_or_open.parts());
  say('#mode-switch [data-mode="view"]', m.switch_view());
  say('#mode-switch [data-mode="transform"]', m.switch_transform());
  found("#status-cmd").setAttribute("aria-label", m.command_aria());
  found("#close").setAttribute("aria-label", m.close_window_aria());
}

function say(selector: string, text: string): void {
  found(selector).textContent = text;
}

/**
 * link writes a sentence with a link in it into the link's line: the words the
 * message marks are the link's, and the rest go around it in the order the
 * language puts them. The link itself is kept, since its click is wired to it.
 */
function link(anchor: HTMLElement, parts: readonly MessagePart[]): void {
  const line = must(anchor.parentElement);
  const nodes: Node[] = [];
  let linked = "";
  let inside = false;
  for (const part of parts) {
    switch (part.type) {
      case "markup-start":
        inside = true;
        nodes.push(anchor);
        break;
      case "markup-end":
        inside = false;
        break;
      case "text":
        if (inside) linked += part.value;
        else nodes.push(document.createTextNode(part.value));
        break;
      case "markup-standalone":
        break;
    }
  }
  anchor.textContent = linked;
  line.replaceChildren(...nodes);
}
