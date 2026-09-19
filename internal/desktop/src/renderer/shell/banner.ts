// The recogniser's question: what it would change and in how many cells, with
// Apply and Not now.

import "./banner.css";

import type { Offer } from "@uno/grid/engine";

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
  const header = document.createElement("b");
  header.textContent = offer.header;

  const n = offer.affects.toLocaleString();
  const count = offer.complete
    ? `${n} ${offer.affects === 1 ? "cell" : "cells"}`
    : `at least ${n} in the first ${offer.scanned.toLocaleString()} rows`;
  const parts = [offer.description, count];
  if (offer.ambiguous) parts.push("another rule fits these examples too");

  const grow = document.createElement("span");
  grow.className = "grow";

  const applyButton = document.createElement("button");
  applyButton.className = "primary";
  applyButton.textContent = "Apply";
  applyButton.addEventListener("click", apply);

  const later = document.createElement("button");
  later.textContent = "Not now";
  later.addEventListener("click", dismiss);

  return [header, document.createTextNode(` · ${parts.join(" · ")}`), grow, applyButton, later];
}
