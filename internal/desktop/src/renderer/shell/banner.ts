// The recogniser's question: what it would change and in how many cells, with
// Apply and Not now.

import "./banner.css";

import type { Offer } from "@uno/grid/engine";

import { m } from "../../paraglide/messages.js";
import { num } from "../locale.ts";
import { say } from "../said.ts";
import { el } from "./util.ts";

/** An offer is the same question while its source, column and program are. */
export function offerKey(offer: Offer): string {
  return `${offer.source}:${offer.col}:${offer.program}`;
}

/**
 * bannerParts asks the question.
 *
 * On a file larger than its first pass, the count grows while the survey reads
 * and says it is a lower bound. Apply works before the count is final: it is
 * one edit, and Ctrl+Z takes it back.
 */
export function bannerParts(offer: Offer, apply: () => void, dismiss: () => void): Node[] {
  const header = el("b", "", offer.header);

  const count = offer.complete
    ? m.cells_count({ count: offer.affects })
    : m.offer_cells_at_least({ affected: num(offer.affects), scanned: offer.scanned });
  const parts = [say(offer.description), count];
  if (offer.ambiguous) parts.push(m.offer_ambiguous());

  const applyButton = el("button", "primary", m.action_apply());
  applyButton.addEventListener("click", apply);
  const later = el("button", "", m.action_not_now());
  later.addEventListener("click", dismiss);

  return [
    header,
    document.createTextNode(` · ${parts.join(" · ")}`),
    el("span", "grow"),
    applyButton,
    later,
  ];
}
