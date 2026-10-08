// What the engine says to a person, as data.
//
// A sentence built here is English, and an engine does not know what language
// the person reading it speaks: it may be in another process, behind a port
// that carries plain data and nothing else. So what it says crosses as which
// sentence it is and what goes in it, and whoever draws it writes it in their
// own language. `english` is the sentence as this package has always said it,
// which is what an Error's message, a log and a test read.
//
// Not everything has a kind of its own yet. What does not is `text`: a
// diagnostic as it was written, in English, passed on whole. Giving one a kind
// is adding it to `Said`, after which the compiler asks for its English here
// and for its message wherever a client writes one.

import { quote } from "../go/strconv.ts";
import type { HeaderMode } from "../store/multi.ts";

/**
 * Charset is the name a file's text is read by, as the status bar shows it.
 * The two are the same word in every language, so the name travels as data.
 */
export type Charset = "UTF-8" | "Windows-1252";

/** The punctuation a description can call by name, as the plural it is called by. */
export type CharName =
  | "commas"
  | "full stops"
  | "dollar signs"
  | "pound signs"
  | "euro signs"
  | "percent signs"
  | "underscores"
  | "apostrophes"
  | "spaces"
  | "asterisks"
  | "hashes"
  | "slashes"
  | "dashes"
  | "plus signs"
  | "brackets"
  | "quotes";

/** What a step of a program looks for: characters by name, or a piece of text as written. */
export type Sought =
  | { t: "chars"; names: CharName[]; where: "anywhere" | "start" | "end" }
  | { t: "literal"; text: string };

/** One step of a program, as a banner describes it. */
export type StepSaid =
  | { t: "trim" }
  | { t: "upper" }
  | { t: "lower" }
  | { t: "remove"; what: Sought }
  | { t: "replace"; what: Sought; with: string }
  /** A step with no sentence for it, shown in the notation a person can learn. */
  | { t: "notation"; text: string };

export type Said =
  /** A diagnostic with no kind of its own yet, as it was written. */
  | { t: "text"; text: string }
  /** What went wrong with something named: "sales.csv: no such file". */
  | { t: "about"; subject: string; why: Said }
  | { t: "replaying"; name: string; why: Said }

  // How a file was read, for the status bar.
  | { t: "read"; delimiter: string; header: HeaderMode; charset: Charset }

  // What a program does, for the recogniser's banner.
  | { t: "program"; steps: StepSaid[] }

  // A file that is not the one a workspace was saved against.
  | { t: "version-changed"; name: string; sizes?: { now: number; was: number } }
  | { t: "size-changed"; name: string; now: number; was: number }

  // What a workspace refuses.
  | { t: "only-source"; name: string }
  | { t: "append-to-absent"; name: string }
  | { t: "append-to-one-file"; name: string }
  | { t: "append-nothing"; name: string }
  | { t: "append-already-part"; file: string; part: number; name: string }
  | { t: "append-twice"; file: string; name: string }
  | { t: "workspace-as-source"; name: string }
  | { t: "workspace-too-large"; name: string; bytes: number; limit: number }
  | { t: "no-file-open" }
  | { t: "carried-too-large"; name: string; bytes: number; limit: number }
  | { t: "carried-together-too-large"; count: number; bytes: number; limit: number }
  | { t: "workspace-closed" }
  | { t: "no-such-source"; id: string }
  | { t: "source-absent"; name: string }
  | { t: "point-one-at-several"; file: string; count: number; name: string }
  | { t: "point-several-at-one"; name: string; count: number; file: string }
  | { t: "point-several-at-other"; name: string; count: number; given: number }
  | { t: "log-lost-edit"; source: string }
  | { t: "bucket-unconnected"; container: string; bucket: string }

  // What a source refuses.
  | { t: "joins-unknown-for-column"; name: string }
  | { t: "joins-unknown-for-save"; name: string; count: number }
  | { t: "rows-past-files"; name: string }
  | { t: "part-has-no-path"; name: string; file: string; part: number; count: number }
  | { t: "nothing-to-undo" }
  | { t: "nothing-to-redo" }
  | { t: "in-view" }
  | { t: "file-closed" }
  | { t: "changed-on-disk"; name: string }

  // What an engine whose platform gave it less cannot do.
  | { t: "keeps-no-connections" }
  | { t: "offers-no-sign-ins" }
  | { t: "tries-no-connection" };

/**
 * Refusal is an error that knows what it says as data, so a client can say it
 * in another language. Its message is the English.
 */
export class Refusal extends Error {
  constructor(readonly said: Said) {
    super(english(said));
    this.name = "Refusal";
  }
}

/** saidOf is what an error says: as data where it knows, and as its text otherwise. */
export function saidOf(err: unknown): Said {
  if (err instanceof Refusal) return err.said;
  return { t: "text", text: err instanceof Error ? err.message : String(err) };
}

/** How many of one unit make the next: bytes in a KB, KB in a MB. */
const UNIT_STEP = 1024;

/** A size under this many of its unit keeps one decimal place. */
const DECIMAL_BELOW = 10;

export function formatBytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= UNIT_STEP && i < units.length - 1) {
    n /= UNIT_STEP;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < DECIMAL_BELOW ? 1 : 0)} ${units[i]}`;
}

/** What the `_file` column shows, as the end of a sentence about it. */
export const FILE_SHOWS = "which file each row came from";

/** englishSought is what a step looks for, in English: "commas and spaces from the end". */
export function englishSought(what: Sought): string {
  if (what.t === "literal") return quote(what.text);
  const names = what.names;
  const listed =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  switch (what.where) {
    case "anywhere":
      return listed;
    case "start":
      return `${listed} from the start`;
    case "end":
      return `${listed} from the end`;
  }
}

/**
 * Sentences is one sentence for each kind of a union, so a kind without one is
 * a type error: here in English, and in a client in whatever language it writes.
 */
export type Sentences<U extends { t: string }> = {
  [K in U["t"]]: (s: Extract<U, { t: K }>) => string;
};

const STEPS: Sentences<StepSaid> = {
  trim: () => "trim the spaces off both ends",
  upper: () => "upper-case it",
  lower: () => "lower-case it",
  remove: (s) => `remove ${englishSought(s.what)}`,
  replace: (s) => `replace ${englishSought(s.what)} with ${quote(s.with)}`,
  notation: (s) => s.text,
};

function step(s: StepSaid): string {
  return (STEPS[s.t] as (s: StepSaid) => string)(s);
}

const SENTENCES: Sentences<Said> = {
  text: (s) => s.text,
  about: (s) => `${s.subject}: ${english(s.why)}`,
  replaying: (s) => `replaying edits to ${s.name}: ${english(s.why)}`,

  read: (s) => {
    // The quoting is Go's `%q` on a rune: a single-quoted character literal.
    const read =
      s.delimiter === "\t"
        ? `${s.charset} · tab-separated`
        : `${s.charset} · delimiter '${s.delimiter}'`;
    return s.header === "first" ? read : `${read} · no header row`;
  },

  program: (s) => (s.steps.length === 0 ? "change nothing" : s.steps.map(step).join(", then ")),

  "version-changed": (s) => {
    const sizes =
      s.sizes === undefined
        ? "it is the same size"
        : `it is ${formatBytes(s.sizes.now)} now and was ${formatBytes(s.sizes.was)}`;
    return `${s.name} is not the version the workspace was saved against · ${sizes}`;
  },
  "size-changed": (s) =>
    `${s.name} is ${formatBytes(s.now)} now and was ${formatBytes(s.was)} when the workspace was saved`,

  "only-source": (s) => `${s.name} is the only source here, and a workspace needs one`,
  "append-to-absent": (s) => `${s.name} has no file behind it, so nothing can be appended to it`,
  "append-to-one-file": (s) =>
    `${s.name} is one file · files are appended only to several read as one`,
  "append-nothing": (s) => `no file was given to append to ${s.name}`,
  "append-already-part": (s) => `${s.file} is already part ${s.part} of ${s.name}`,
  "append-twice": (s) => `${s.file} is given twice to append to ${s.name}`,
  "workspace-as-source": (s) =>
    `${s.name} is a workspace of its own · open it rather than adding it`,
  "workspace-too-large": (s) =>
    `${s.name} is ${formatBytes(s.bytes)}, over the ${formatBytes(s.limit)} a workspace can be read whole`,
  "no-file-open": () => "no file is open",
  "carried-too-large": (s) =>
    `${s.name} is ${formatBytes(s.bytes)}, over the ${formatBytes(s.limit)} a workspace can carry for a source it has no file to point at`,
  "carried-together-too-large": (s) =>
    `the ${s.count} sources with no file behind them come to ${formatBytes(s.bytes)}, over the ${formatBytes(s.limit)} a workspace can carry`,
  "workspace-closed": () => "the workspace was closed",
  "no-such-source": (s) => `no source called ${s.id} is open`,
  "source-absent": (s) => `${s.name} has no file behind it · point it at one to read its rows`,
  "point-one-at-several": (s) =>
    `${s.file} is ${s.count} files read as one, and ${s.name} cannot be pointed at one yet`,
  "point-several-at-one": (s) =>
    `${s.name} is ${s.count} files read as one, and ${s.file} is one file`,
  "point-several-at-other": (s) =>
    `${s.name} is ${s.count} files read as one, and cannot be pointed at ${s.given}`,
  "log-lost-edit": (s) => `the log lost track of an edit to ${s.source}`,
  "bucket-unconnected": (s) =>
    `${s.container} reads s3://${s.bucket}/…, which no connection covers · connect ${s.bucket} to read it`,

  "joins-unknown-for-column": (s) =>
    `${s.name} is read as one by something that does not say how its files join, so it cannot show ${FILE_SHOWS}`,
  "joins-unknown-for-save": (s) =>
    `${s.name} is ${s.count} files read as one by something that does not say how they join, so a workspace cannot save it`,
  "rows-past-files": (s) => `${s.name}: its rows run past the files it is read from`,
  "part-has-no-path": (s) =>
    `${s.name}: ${s.file} (part ${s.part} of ${s.count}) is a dropped file with no path, and a workspace points at each part of several files read as one`,
  "nothing-to-undo": () => "there is nothing to undo",
  "nothing-to-redo": () => "there is nothing to redo",
  "in-view": () => "the file is in view · Ctrl+E to transform",
  "file-closed": () => "the file was closed",
  "changed-on-disk": (s) => `${s.name} changed on disk after it was opened`,

  "keeps-no-connections": () =>
    "this engine keeps no connections · its platform gave it nowhere to read them from",
  "offers-no-sign-ins": () =>
    "this engine has no way of signing in to offer · its platform connects to nothing",
  "tries-no-connection": () =>
    "this engine cannot try a connection · its platform connects to nothing",
};

/** english is the sentence in English, as this package has always written it. */
export function english(s: Said): string {
  // The table is typed by kind, and s is the union, so the one pairing the
  // compiler cannot see is said here: each sentence takes its own kind.
  return (SENTENCES[s.t] as (s: Said) => string)(s);
}
