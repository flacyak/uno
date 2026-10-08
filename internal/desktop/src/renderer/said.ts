// What the engine says, written in the language the app is in.
//
// The engine sends a sentence as data: which one it is, and what goes in it.
// It may be in another process, and it does not know what language the person
// reading speaks. `say` is the other half: one message for each kind, so a
// kind the engine gains fails to compile here until it has one.
//
// What the engine has given no kind of its own yet arrives as `text`, in the
// English it was written in, and is passed on as it is.

import { Refusal } from "@uno/grid/engine";
import type { CharName, Said, Sought, StepSaid } from "@uno/grid/engine";
import { quote } from "@uno/grid/go";

import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { bytes, num } from "./locale.ts";

/** said is what an error says, in the app's language where the engine sent it as data. */
export function said(err: unknown): string {
  if (err instanceof Refusal) return say(err.said);
  return err instanceof Error ? err.message : String(err);
}

/** One message a kind, stored as the function and not its text, so it is said in the language of the moment. */
const CHARS: Record<CharName, () => string> = {
  commas: m.chars_commas,
  "full stops": m.chars_full_stops,
  "dollar signs": m.chars_dollar_signs,
  "pound signs": m.chars_pound_signs,
  "euro signs": m.chars_euro_signs,
  "percent signs": m.chars_percent_signs,
  underscores: m.chars_underscores,
  apostrophes: m.chars_apostrophes,
  spaces: m.chars_spaces,
  asterisks: m.chars_asterisks,
  hashes: m.chars_hashes,
  slashes: m.chars_slashes,
  dashes: m.chars_dashes,
  "plus signs": m.chars_plus_signs,
  brackets: m.chars_brackets,
  quotes: m.chars_quotes,
};

function charName(name: CharName): string {
  return CHARS[name]();
}

/**
 * quoted is a piece of text between the language's quotation marks, with what
 * could not be seen in it written as an escape: a tab is \t.
 */
function quoted(text: string): string {
  // The engine's quote escapes, and puts its own marks at each end.
  return m.quoted({ text: quote(text).slice(1, -1) });
}

/** What a step looks for, without where: the characters by name, or the text in quotes. */
function sought(what: Sought): string {
  if (what.t === "literal") return quoted(what.text);
  return new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(what.names.map(charName));
}

/** Where a step looks: anywhere in the cell, or at one end of it. */
type Where = Extract<Sought, { t: "chars" }>["where"];

function whereOf(what: Sought): Where {
  return what.t === "chars" ? what.where : "anywhere";
}

const REMOVES: Record<Where, (p: { what: string }) => string> = {
  anywhere: m.step_remove,
  start: m.step_remove_from_start,
  end: m.step_remove_from_end,
};

const REPLACES: Record<Where, (p: { what: string; with: string }) => string> = {
  anywhere: m.step_replace,
  start: m.step_replace_from_start,
  end: m.step_replace_from_end,
};

/** Sentences is one message for each kind, so a kind the engine gains fails to compile here until it has one. */
type Sentences<U extends { t: string }> = { [K in U["t"]]: (s: Extract<U, { t: K }>) => string };

const STEPS: Sentences<StepSaid> = {
  trim: m.step_trim,
  upper: m.step_upper,
  lower: m.step_lower,
  remove: (s) => REMOVES[whereOf(s.what)]({ what: sought(s.what) }),
  replace: (s) => REPLACES[whereOf(s.what)]({ what: sought(s.what), with: quoted(s.with) }),
  notation: (s) => s.text,
};

function step(s: StepSaid): string {
  return (STEPS[s.t] as (s: StepSaid) => string)(s);
}

const SAYS: Sentences<Said> = {
  text: (s) => s.text,
  about: (s) => m.said_about({ subject: s.subject, why: say(s.why) }),
  replaying: (s) => m.said_replaying({ name: s.name, why: say(s.why) }),

  read: (s) => {
    const headed = s.header === "first";
    const tabs = { charset: s.charset };
    if (s.delimiter === "\t") return headed ? m.read_tabs(tabs) : m.read_tabs_no_header(tabs);
    const read = { charset: s.charset, delimiter: s.delimiter };
    return headed ? m.read_delimiter(read) : m.read_delimiter_no_header(read);
  },

  program: (s) => {
    const [first, ...rest] = s.steps.map(step);
    if (first === undefined) return m.program_nothing();
    return rest.reduce((before, after) => m.program_then({ before, after }), first);
  },

  "version-changed": (s) =>
    s.sizes === undefined
      ? m.changed_version_same_size({ name: s.name })
      : m.changed_version_sizes({
          name: s.name,
          now: bytes(s.sizes.now),
          was: bytes(s.sizes.was),
        }),
  "size-changed": (s) => m.changed_size({ name: s.name, now: bytes(s.now), was: bytes(s.was) }),

  "only-source": (s) => m.refused_only_source({ name: s.name }),
  "append-to-absent": (s) => m.refused_append_to_absent({ name: s.name }),
  "append-to-one-file": (s) => m.refused_append_to_one_file({ name: s.name }),
  "append-nothing": (s) => m.refused_append_nothing({ name: s.name }),
  "append-already-part": (s) =>
    m.refused_append_already_part({ file: s.file, part: num(s.part), name: s.name }),
  "append-twice": (s) => m.refused_append_twice({ file: s.file, name: s.name }),
  "workspace-as-source": (s) => m.workspace_not_a_source({ name: s.name }),
  "workspace-too-large": (s) =>
    m.refused_workspace_too_large({ name: s.name, size: bytes(s.bytes), limit: bytes(s.limit) }),
  "no-file-open": m.refused_no_file_open,
  "carried-too-large": (s) =>
    m.refused_carried_too_large({ name: s.name, size: bytes(s.bytes), limit: bytes(s.limit) }),
  "carried-together-too-large": (s) =>
    m.refused_carried_together_too_large({
      count: s.count,
      size: bytes(s.bytes),
      limit: bytes(s.limit),
    }),
  "workspace-closed": m.refused_workspace_closed,
  "no-such-source": (s) => m.refused_no_such_source({ id: s.id }),
  "source-absent": (s) => m.refused_source_absent({ name: s.name }),
  "point-one-at-several": (s) =>
    m.refused_point_one_at_several({ file: s.file, count: s.count, name: s.name }),
  "point-several-at-one": (s) =>
    m.refused_point_several_at_one({ name: s.name, count: s.count, file: s.file }),
  "point-several-at-other": (s) =>
    m.refused_point_several_at_other({ name: s.name, count: s.count, given: num(s.given) }),
  "log-lost-edit": (s) => m.refused_log_lost_edit({ source: s.source }),
  "bucket-unconnected": (s) =>
    m.refused_bucket_unconnected({ container: s.container, bucket: s.bucket }),

  "joins-unknown-for-column": (s) => m.refused_joins_unknown_for_column({ name: s.name }),
  "joins-unknown-for-save": (s) =>
    m.refused_joins_unknown_for_save({ name: s.name, count: s.count }),
  "rows-past-files": (s) => m.refused_rows_past_files({ name: s.name }),
  "part-has-no-path": (s) =>
    m.refused_part_has_no_path({
      name: s.name,
      file: s.file,
      part: num(s.part),
      count: num(s.count),
    }),
  "nothing-to-undo": m.refused_nothing_to_undo,
  "nothing-to-redo": m.refused_nothing_to_redo,
  "in-view": m.refused_in_view,
  "file-closed": m.refused_file_closed,
  "changed-on-disk": (s) => m.refused_changed_on_disk({ name: s.name }),

  "keeps-no-connections": m.refused_keeps_no_connections,
  "offers-no-profiles": m.refused_offers_no_profiles,
  "tries-no-connection": m.refused_tries_no_connection,
};

/** say is one thing the engine said, in the language the app is in now. */
export function say(s: Said): string {
  // The table is typed by kind, and s is the union, so the one pairing the
  // compiler cannot see is said here: each message takes its own kind.
  return (SAYS[s.t] as (s: Said) => string)(s);
}
