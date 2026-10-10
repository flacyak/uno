// The banner for an offer: what it would change, how many cells, and the
// Apply and Not now buttons.

import "./banner.css";

import type { Offer } from "@uno/grid/engine";

import { m } from "../../paraglide/messages.js";
import { num } from "../locale.ts";
import { say } from "../said.ts";
import { el } from "./util.ts";

/** offerKey identifies an offer by its source, column and program. */
export function offerKey(offer: Offer): string {
  return `${offer.source}:${offer.col}:${offer.program}`;
}

/**
 * bannerParts builds the banner's nodes for an offer. While the survey is
 * incomplete the count is shown as a lower bound. Apply works before the
 * count is final.
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
