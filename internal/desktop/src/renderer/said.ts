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

function charName(name: CharName): string {
  switch (name) {
    case "commas":
      return m.chars_commas();
    case "full stops":
      return m.chars_full_stops();
    case "dollar signs":
      return m.chars_dollar_signs();
    case "pound signs":
      return m.chars_pound_signs();
    case "euro signs":
      return m.chars_euro_signs();
    case "percent signs":
      return m.chars_percent_signs();
    case "underscores":
      return m.chars_underscores();
    case "apostrophes":
      return m.chars_apostrophes();
    case "spaces":
      return m.chars_spaces();
    case "asterisks":
      return m.chars_asterisks();
    case "hashes":
      return m.chars_hashes();
    case "slashes":
      return m.chars_slashes();
    case "dashes":
      return m.chars_dashes();
    case "plus signs":
      return m.chars_plus_signs();
    case "brackets":
      return m.chars_brackets();
    case "quotes":
      return m.chars_quotes();
  }
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

function step(s: StepSaid): string {
  switch (s.t) {
    case "trim":
      return m.step_trim();
    case "upper":
      return m.step_upper();
    case "lower":
      return m.step_lower();
    case "remove": {
      const what = { what: sought(s.what) };
      const where = s.what.t === "chars" ? s.what.where : "anywhere";
      switch (where) {
        case "anywhere":
          return m.step_remove(what);
        case "start":
          return m.step_remove_from_start(what);
        case "end":
          return m.step_remove_from_end(what);
      }
      break;
    }
    case "replace": {
      const parts = { what: sought(s.what), with: quoted(s.with) };
      const where = s.what.t === "chars" ? s.what.where : "anywhere";
      switch (where) {
        case "anywhere":
          return m.step_replace(parts);
        case "start":
          return m.step_replace_from_start(parts);
        case "end":
          return m.step_replace_from_end(parts);
      }
      break;
    }
    case "notation":
      return s.text;
  }
}

/** say is one thing the engine said, in the language the app is in now. */
export function say(s: Said): string {
  switch (s.t) {
    case "text":
      return s.text;
    case "about":
      return m.said_about({ subject: s.subject, why: say(s.why) });
    case "replaying":
      return m.said_replaying({ name: s.name, why: say(s.why) });

    case "read": {
      const headed = s.header === "first";
      if (s.delimiter === "\t") return headed ? m.read_tabs() : m.read_tabs_no_header();
      const read = { delimiter: s.delimiter };
      return headed ? m.read_delimiter(read) : m.read_delimiter_no_header(read);
    }

    case "program": {
      const [first, ...rest] = s.steps.map(step);
      if (first === undefined) return m.program_nothing();
      return rest.reduce((before, after) => m.program_then({ before, after }), first);
    }

    case "version-changed":
      return s.sizes === undefined
        ? m.changed_version_same_size({ name: s.name })
        : m.changed_version_sizes({
            name: s.name,
            now: bytes(s.sizes.now),
            was: bytes(s.sizes.was),
          });
    case "size-changed":
      return m.changed_size({ name: s.name, now: bytes(s.now), was: bytes(s.was) });

    case "only-source":
      return m.refused_only_source({ name: s.name });
    case "append-to-absent":
      return m.refused_append_to_absent({ name: s.name });
    case "append-to-one-file":
      return m.refused_append_to_one_file({ name: s.name });
    case "append-nothing":
      return m.refused_append_nothing({ name: s.name });
    case "append-already-part":
      return m.refused_append_already_part({ file: s.file, part: num(s.part), name: s.name });
    case "append-twice":
      return m.refused_append_twice({ file: s.file, name: s.name });
    case "workspace-as-source":
      return m.workspace_not_a_source({ name: s.name });
    case "workspace-too-large":
      return m.refused_workspace_too_large({
        name: s.name,
        size: bytes(s.bytes),
        limit: bytes(s.limit),
      });
    case "no-file-open":
      return m.refused_no_file_open();
    case "carried-too-large":
      return m.refused_carried_too_large({
        name: s.name,
        size: bytes(s.bytes),
        limit: bytes(s.limit),
      });
    case "carried-together-too-large":
      return m.refused_carried_together_too_large({
        count: s.count,
        size: bytes(s.bytes),
        limit: bytes(s.limit),
      });
    case "workspace-closed":
      return m.refused_workspace_closed();
    case "no-such-source":
      return m.refused_no_such_source({ id: s.id });
    case "source-absent":
      return m.refused_source_absent({ name: s.name });
    case "point-one-at-several":
      return m.refused_point_one_at_several({ file: s.file, count: s.count, name: s.name });
    case "point-several-at-one":
      return m.refused_point_several_at_one({ name: s.name, count: s.count, file: s.file });
    case "point-several-at-other":
      return m.refused_point_several_at_other({
        name: s.name,
        count: s.count,
        given: num(s.given),
      });
    case "log-lost-edit":
      return m.refused_log_lost_edit({ source: s.source });
    case "bucket-unconnected":
      return m.refused_bucket_unconnected({ container: s.container, bucket: s.bucket });

    case "joins-unknown-for-column":
      return m.refused_joins_unknown_for_column({ name: s.name });
    case "joins-unknown-for-save":
      return m.refused_joins_unknown_for_save({ name: s.name, count: s.count });
    case "rows-past-files":
      return m.refused_rows_past_files({ name: s.name });
    case "part-has-no-path":
      return m.refused_part_has_no_path({
        name: s.name,
        file: s.file,
        part: num(s.part),
        count: num(s.count),
      });
    case "nothing-to-undo":
      return m.refused_nothing_to_undo();
    case "nothing-to-redo":
      return m.refused_nothing_to_redo();
    case "in-view":
      return m.refused_in_view();
    case "file-closed":
      return m.refused_file_closed();
    case "changed-on-disk":
      return m.refused_changed_on_disk({ name: s.name });

    case "keeps-no-connections":
      return m.refused_keeps_no_connections();
    case "offers-no-profiles":
      return m.refused_offers_no_profiles();
    case "tries-no-connection":
      return m.refused_tries_no_connection();
  }
}
