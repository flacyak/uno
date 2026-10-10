// Package pattern induces a transform program from the edits a person made to
// a column, so the app can offer to apply it to the rest.

export { MIN_EXAMPLES, SAMPLE_SIZE, Snapshot, Survey, gather, snap } from "./pattern.ts";
export type { Change, Proposal } from "./pattern.ts";
export { align, alignText, MAX_DIFF } from "./align.ts";
export type { Alignment, Run } from "./align.ts";
export { droppedChars, induce, rewrites, unionDeletion } from "./induce.ts";
export type { Example } from "./induce.ts";
export { restructures } from "./restructure.ts";
