// Writes the page's static text: the sidebar head, the empty state, the mode
// switch labels, and the aria labels. index.html holds the elements with no
// text. The text is written here when the shell starts and again when the
// language changes, along with the document's lang and dir.

import { m } from "../../paraglide/messages.js";
import { getLocale, getTextDirection } from "../../paraglide/runtime.js";
import type { MessagePart } from "../../paraglide/runtime.js";
import { found, must } from "./util.ts";

/** labelPage writes the page's static text in the current language. */
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
 * link writes a message with markup into the anchor's parent. Text inside the
 * markup becomes the anchor's text; text outside it becomes text nodes around
 * the anchor. The anchor element is reused, so its click handler stays.
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
