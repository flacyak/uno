// Connect a bucket, on the desktop: a bucket, a folder in it, how to sign in,
// and a test that lists the folder before anything is kept.
//
// It takes the panel's place while it is open, because connecting is the one
// thing in the panel that is a form rather than a list, and a person filling
// it in is not also browsing. The test is the point of it. A connection that
// cannot list its folder -- a 403, a bucket that is not there, an SSO sign-in
// that has expired -- says why in the engine's own words and saves nothing, so
// a connection in the folder is one that worked at least once.
//
// The profile list comes from the engine, which reads ~/.aws in its own
// process and hands over names and nothing else (2.10). The region is not
// asked for at all: the test finds it (2.9), and the connection keeps it.

import type { Connection } from "@uno/grid/library";
import { validConnection } from "@uno/grid/library";
import type { Tried } from "@uno/grid/store/s3";

import { m } from "../../paraglide/messages.js";
import { Words, message } from "./util.ts";

/** What the form needs of the engine and the host. The shell decides how. */
export interface ConnectAsks {
  /** The names of the AWS profiles this machine has. */
  profiles(): Promise<string[]>;
  /** A connection tried without keeping it: its region, and a page of its prefix. */
  tryConnection(c: Connection): Promise<Tried>;
  /** Keep a connection, and hand back the copy that was written. */
  save(c: Connection): Promise<Connection>;
  /** The connections already kept, so a new one does not take an old one's file. */
  known(): readonly Connection[];
}

/**
 * What the form says of a save while it is under way. A save takes a test and
 * a write, and the form steps aside for both, so that the connection is seen
 * arriving where it will be listed.
 */
export interface ConnectTells {
  /** A save began, and the form has stepped aside for this connection. */
  keeping(draft: Connection): void;
  /**
   * The save was refused, and why. The form stays aside, as it was left, until
   * `reopen` brings it back to be edited and saved again.
   */
  refused(draft: Connection, why: string): void;
}

/** What the form can be opened with: a bucket somebody already named. */
export interface Filled {
  bucket?: string;
  prefix?: string;
}

/**
 * SignIn is the profile list's choice, as the select carries it: the machine's
 * own chain, a named profile, or no signing in at all.
 */
export type SignIn = "machine" | "public" | `profile:${string}`;

/** The fields as a person left them. */
export interface Fields {
  bucket: string;
  prefix: string;
  signIn: SignIn;
}

/**
 * folderOf is a prefix as a connection keeps it: no slash in front, and one on
 * the end, since `shop` without it would cover `shop-old/` too. Typed with or
 * without either, it means the same folder.
 */
export function folderOf(typed: string): string {
  const inner = typed.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return inner === "" ? "" : `${inner}/`;
}

/**
 * draftOf is the connection the fields describe, not yet tried or kept.
 *
 * Its id names its file, so it is the bucket's name, and a connection already
 * kept for another folder of the same bucket keeps its file: the new one is
 * `-2`, `-3`. One already kept for this same bucket and folder is the one
 * being made again, and keeps its id, its name and when it was created.
 */
export function draftOf(fields: Fields, known: readonly Connection[]): Connection {
  const bucket = fields.bucket.trim();
  const prefix = folderOf(fields.prefix);
  const again = known.find((c) => c.bucket === bucket && c.prefix === prefix);
  const auth: Connection["auth"] =
    fields.signIn === "machine" || fields.signIn === "public"
      ? { mode: fields.signIn }
      : { mode: "profile", profile: fields.signIn.slice("profile:".length) };

  let id = again?.id ?? bucket;
  if (again === undefined) {
    const taken = new Set(known.map((c) => c.id));
    for (let n = 2; taken.has(id); n++) id = `${bucket}-${n}`;
  }
  return {
    format: 1,
    id,
    name: again?.name ?? (prefix === "" ? bucket : `${bucket} / ${prefix.slice(0, -1)}`),
    provider: "s3",
    bucket,
    prefix,
    auth,
    created: again?.created,
    modified: again?.modified,
  };
}

/** A bucket's name as an example of one, in the field before anything is typed. */
const EXAMPLE_BUCKET = "acme-exports";

/** What stands for the region of a bucket the test could not place. */
const UNKNOWN_REGION = "?";

/** triedLine is what a test that worked says: the folder, and what it held. */
export function triedLine(tried: Tried): string {
  const held = {
    folders: m.folders_count({ count: tried.folders }),
    files: m.files_count({ count: tried.files }),
  };
  const found = tried.more ? m.connect_found_more(held) : m.connect_found(held);
  const prefix = tried.connection.prefix;
  return prefix === ""
    ? m.connect_listed_bucket({ found })
    : m.connect_listed_prefix({ prefix, found });
}

/** Where the form is: waiting to be tried, trying, tried and fine, or refused. */
type Status =
  | { t: "untried" }
  | { t: "trying" }
  | { t: "tried"; tried: Tried; draft: string }
  | { t: "refused"; why: string };

export class ConnectForm {
  readonly el = document.createElement("form");
  /** What the form says that does not change with what is typed in it. */
  private readonly words = new Words();
  private readonly bucket = input("bucket");
  private readonly prefix = input("prefix");
  private readonly signIn = document.createElement("select");
  private readonly region = document.createElement("div");
  private readonly result = document.createElement("div");
  private readonly saving = document.createElement("div");
  private readonly tryButton = button("");
  private readonly saveButton = button("primary");
  /** The profile names the engine last answered with, for the list to be drawn from again. */
  private names: readonly string[] = [];
  private status: Status = { t: "untried" };
  /** Counts tries, so an answer for fields that have since changed is dropped. */
  private tries = 0;
  /** Whether the person picked a profile, so the names arriving do not undo it. */
  private picked = false;
  /** The connection a save has stepped aside for, until it is kept or refused. */
  private keeping: Connection | undefined;

  constructor(
    private readonly asks: ConnectAsks,
    /** Called when the form is done: with what was saved, or nothing for Cancel. */
    private readonly done: (saved: Connection | undefined) => void,
    private readonly tells: ConnectTells,
  ) {
    const el = this.el;
    el.className = "panel-connect";
    el.hidden = true;
    el.noValidate = true;
    const words = this.words;
    words.attr(el, "aria-label", m.connect_form_aria);

    const title = document.createElement("div");
    title.className = "title";
    words.text(title, m.connect_title);

    words.attr(this.bucket, "aria-label", m.connect_bucket_aria);
    this.bucket.placeholder = EXAMPLE_BUCKET;
    words.attr(this.prefix, "aria-label", m.connect_prefix_aria);
    words.placeholder(this.prefix, m.connect_prefix_placeholder);
    words.text(this.tryButton, m.action_test);
    words.text(this.saveButton, m.connect_save);
    words.attr(this.signIn, "aria-label", m.connect_sign_in_aria);
    this.signIn.addEventListener("change", () => (this.picked = true));
    this.region.className = "value";
    this.result.className = "result";
    this.result.setAttribute("role", "status");
    this.saving.className = "fine";

    const cancel = words.text(button(""), m.action_cancel);
    cancel.type = "button";
    cancel.addEventListener("click", () => this.cancel());
    this.tryButton.type = "button";
    this.tryButton.addEventListener("click", () => void this.test());
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    buttons.append(cancel, this.tryButton, this.saveButton);

    el.append(
      title,
      field(words, m.field_bucket, this.bucket),
      field(words, m.field_prefix, this.prefix),
      field(words, m.field_profile, this.signIn),
      field(words, m.field_region, this.region),
      this.result,
      buttons,
      this.saving,
    );

    // Enter in any field, and the Save button, are one submit: save, testing
    // first when what is on screen has not been tested yet.
    el.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });
    el.addEventListener("input", () => this.edited());
    el.addEventListener("change", () => this.edited());
    el.addEventListener("keydown", (e) => {
      // The grid's keys and the shell's chords stay out of what is typed here.
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        this.cancel();
      }
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** relabel writes the form again in the language the app is in now, as it stands. */
  relabel(): void {
    this.words.write();
    this.options(this.names);
    this.paint();
  }

  /**
   * show opens the form, filled in with what the caller knows, and asks the
   * engine for the profile names while the person types the bucket.
   */
  show(filled: Filled = {}): void {
    this.bucket.value = filled.bucket ?? "";
    this.prefix.value = filled.prefix ?? "";
    this.status = { t: "untried" };
    this.tries++;
    this.keeping = undefined;
    this.picked = false;
    this.el.hidden = false;
    this.options([]);
    this.paint();
    void this.asks.profiles().then(
      (names) => this.options(names),
      // A machine with no ~/.aws still connects: as itself, or to a public bucket.
      () => this.options([]),
    );
    (filled.bucket === undefined ? this.bucket : this.prefix).focus();
  }

  hide(): void {
    this.el.hidden = true;
    this.tries++;
    this.keeping = undefined;
  }

  /** The fields as a connection, or the reason they are not one yet. */
  private draft(): Connection | string {
    const c = draftOf(
      { bucket: this.bucket.value, prefix: this.prefix.value, signIn: this.signIn.value as SignIn },
      this.asks.known(),
    );
    if (c.bucket === "") return m.connect_name_bucket();
    try {
      validConnection(c);
    } catch (err) {
      return message(err);
    }
    return c;
  }

  /**
   * test tries what is on screen and says what came of it. An answer that
   * lands after the fields changed is for a connection nobody is looking at
   * any more, and is dropped.
   */
  private async test(): Promise<Tried | undefined> {
    const draft = this.draft();
    if (typeof draft === "string") {
      this.status = { t: "refused", why: draft };
      this.paint();
      return undefined;
    }
    const mine = ++this.tries;
    this.status = { t: "trying" };
    this.paint();
    try {
      const tried = await this.asks.tryConnection(draft);
      if (mine !== this.tries) return undefined;
      this.status = { t: "tried", tried, draft: key(draft) };
      this.paint();
      return tried;
    } catch (err) {
      if (mine !== this.tries) return undefined;
      this.status = { t: "refused", why: message(err) };
      this.paint();
      return undefined;
    }
  }

  /**
   * save keeps the connection the test found, with its region in it. What has
   * not been tested is tested first, and a test that fails saves nothing.
   *
   * The form steps aside while it does, and stays aside when the test or the
   * write is refused, as it was left and holding why, for `reopen`. A form
   * opened again or closed meanwhile has given this save up, and what lands
   * for it is dropped.
   */
  private async save(): Promise<void> {
    const draft = this.draft();
    if (typeof draft === "string") {
      this.status = { t: "refused", why: draft };
      this.paint();
      return;
    }
    const s = this.status;
    const tested = s.t === "tried" && s.draft === key(draft) ? s.tried : undefined;

    this.keeping = draft;
    this.el.hidden = true;
    this.tells.keeping(draft);

    const tried = tested ?? (await this.test());
    if (this.keeping !== draft) return;
    // A test that came back with nothing for this save was refused, and said why.
    if (tried === undefined) {
      return this.refuse(draft, this.status.t === "refused" ? this.status.why : "");
    }
    try {
      const saved = await this.asks.save(tried.connection);
      if (this.keeping !== draft) return;
      this.hide();
      this.done(saved);
    } catch (err) {
      if (this.keeping !== draft) return;
      this.refuse(draft, message(err));
    }
  }

  /** refuse ends the save the form stepped aside for, and says why to whoever holds it. */
  private refuse(draft: Connection, why: string): void {
    this.keeping = undefined;
    this.status = { t: "refused", why };
    this.tells.refused(draft, why);
  }

  /**
   * reopen brings the form back as it was left when its save was refused,
   * saying why, with the keys in the bucket: the connection is edited, and
   * saving it is trying it again.
   */
  reopen(): void {
    this.el.hidden = false;
    this.paint();
    this.bucket.focus();
  }

  private cancel(): void {
    this.hide();
    this.done(undefined);
  }

  /** A field changed, so whatever the last test said is about something else. */
  private edited(): void {
    if (this.status.t === "untried") return this.paint();
    this.tries++;
    this.status = { t: "untried" };
    this.paint();
  }

  /** options fills the profile list: the machine's own chain, each profile, and public. */
  private options(names: readonly string[]): void {
    this.names = names;
    const was = this.signIn.value;
    const choices: Array<[SignIn, string]> = [
      ["machine", m.connect_sign_in_machine()],
      ...names.map((n): [SignIn, string] => [`profile:${n}`, n]),
      ["public", m.connect_sign_in_public()],
    ];
    this.signIn.replaceChildren(
      ...choices.map(([value, label]) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        return o;
      }),
    );
    // A choice made before the names arrived is kept; otherwise `default` is
    // what a person means when they did not say, where there is one.
    const keep =
      this.picked && choices.some(([v]) => v === was)
        ? was
        : names.includes("default")
          ? "profile:default"
          : "machine";
    this.signIn.value = keep;
  }

  private paint(): void {
    const s = this.status;
    this.region.textContent =
      s.t === "tried"
        ? m.connect_region_detected({ region: s.tried.connection.region ?? UNKNOWN_REGION })
        : m.connect_region_pending();
    this.region.classList.toggle("found", s.t === "tried");

    this.result.className = `result ${s.t}`;
    this.result.textContent =
      s.t === "trying"
        ? m.connect_listing()
        : s.t === "tried"
          ? `✓ ${triedLine(s.tried)}`
          : s.t === "refused"
            ? `✗ ${s.why}`
            : "";
    this.tryButton.disabled = s.t === "trying";
    this.saveButton.disabled = s.t === "trying";

    // Where it will go, once there is a bucket to name the file after.
    const draft = this.draft();
    this.saving.textContent =
      typeof draft === "string" ? m.connect_saving_each() : m.connect_saving_as({ id: draft.id });
  }
}

/** key is what a test was of, so a save can tell whether the fields moved since. */
function key(c: Connection): string {
  return JSON.stringify([c.bucket, c.prefix, c.auth]);
}

/** input is one text field, by its name in the form. */
function input(name: string): HTMLInputElement {
  const el = document.createElement("input");
  el.name = name;
  el.spellcheck = false;
  el.autocomplete = "off";
  return el;
}

function button(cls: string): HTMLButtonElement {
  const el = document.createElement("button");
  if (cls !== "") el.className = cls;
  return el;
}

/** field is one labelled row of the form. */
function field(words: Words, label: () => string, control: HTMLElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "field";
  row.append(words.text(document.createElement("span"), label), control);
  return row;
}
