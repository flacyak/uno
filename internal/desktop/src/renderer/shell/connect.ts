// The connect form: a bucket, a folder in it, how to sign in, and a test that
// lists the folder. It takes the panel list's place while open.
//
// A connection is saved only after a test that lists its folder succeeds. The
// sign-in options come from the engine. The region is found by the test and
// kept in the connection.

import type { SignIns } from "@uno/grid/engine";
import type { AuthMode, Connection } from "@uno/grid/library";
import { validConnection } from "@uno/grid/library";
import type { Tried } from "@uno/grid/store/s3";

import { m } from "../../paraglide/messages.js";
import { Words, el, message, option } from "./util.ts";

/** What the form asks of the shell. */
export interface ConnectAsks {
  /**
   * The engine's sign-in modes, the AWS profiles on its machine, and what a
   * role has to trust.
   */
  signIns(): Promise<SignIns>;
  /**
   * Test a connection before it is saved. Returns its region and a page of its
   * prefix.
   */
  tryConnection(c: Connection): Promise<Tried>;
  /** Save a connection. Returns the copy that was written. */
  save(c: Connection): Promise<Connection>;
  /** The connections already saved, so a new one gets an unused id. */
  known(): readonly Connection[];
}

/**
 * What the form tells the panel about a save in progress. The form hides
 * itself during the test and the write.
 */
export interface ConnectTells {
  /** A save began and the form has hidden itself. */
  keeping(draft: Connection): void;
  /** The save was refused with `why`. The form stays hidden until `reopen`. */
  refused(draft: Connection, why: string): void;
}

/** Values the form can be opened with. */
export interface Filled {
  bucket?: string;
  prefix?: string;
}

/**
 * SignIn is the sign-in select's value: the machine's credential chain, a
 * named profile, a role, or public access.
 */
export type SignIn = "machine" | "public" | "role" | `profile:${string}`;

/** The field values. */
export interface Fields {
  bucket: string;
  prefix: string;
  signIn: SignIn;
  /** The role's ARN, used when `signIn` is "role". */
  roleArn?: string;
}

/** The select options for each sign-in mode: one option, or one per profile. */
const CHOICES: { [M in AuthMode]: (offered: SignIns) => Array<[SignIn, string]> } = {
  machine: () => [["machine", m.connect_sign_in_machine()]],
  profile: (offered) => offered.profiles.map((n) => [`profile:${n}`, n]),
  role: () => [["role", m.connect_sign_in_role()]],
  public: () => [["public", m.connect_sign_in_public()]],
};

/** The options before the engine answers, and when it fails to: public only. */
const PUBLIC_ONLY: SignIns = { modes: ["public"], profiles: [] };

/**
 * folderOf normalises a prefix: leading slashes stripped, one trailing slash,
 * and "" for an empty prefix.
 */
export function folderOf(typed: string): string {
  const inner = typed.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return inner === "" ? "" : `${inner}/`;
}

/**
 * draftOf builds the connection the fields describe.
 *
 * The id is the bucket name, with `-2`, `-3` appended while that id is
 * taken. A known connection with the same bucket and prefix is being edited:
 * its id, name, created, modified and unknown keys are kept. The auth
 * block's unknown keys are kept only while the auth mode is the same.
 */
export function draftOf(fields: Fields, known: readonly Connection[]): Connection {
  const bucket = fields.bucket.trim();
  const prefix = folderOf(fields.prefix);
  const again = known.find((c) => c.bucket === bucket && c.prefix === prefix);
  const auth: Connection["auth"] =
    fields.signIn === "role"
      ? { mode: "role", roleArn: (fields.roleArn ?? "").trim() }
      : fields.signIn === "machine" || fields.signIn === "public"
        ? { mode: fields.signIn }
        : { mode: "profile", profile: fields.signIn.slice("profile:".length) };
  if (again?.auth.mode === auth.mode && again.auth.extra !== undefined) {
    auth.extra = again.auth.extra;
  }

  let id = again?.id ?? bucket;
  if (again === undefined) {
    const taken = new Set(known.map((c) => c.id));
    for (let n = 2; taken.has(id); n++) id = `${bucket}-${n}`;
  }
  const draft: Connection = {
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
  if (again?.extra !== undefined) draft.extra = again.extra;
  return draft;
}

/** The bucket field's placeholder. */
const EXAMPLE_BUCKET = "acme-exports";

/** The role field's placeholder, in the shape the library requires. */
const EXAMPLE_ROLE = "arn:aws:iam::123456789012:role/uno-read";

/** Shown as the region when the test left it blank. */
const UNKNOWN_REGION = "?";

/**
 * triedLine is the message for a successful test: the folder and what it held.
 */
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

/** The form's state. */
type Status =
  | { t: "untried" }
  | { t: "trying" }
  | { t: "tried"; tried: Tried; draft: string }
  | { t: "refused"; why: string };

export class ConnectForm {
  readonly el = document.createElement("form");
  /** The form's fixed text, rewritten on relabel. */
  private readonly words = new Words();
  private readonly bucket = input("bucket");
  private readonly prefix = input("prefix");
  private readonly signIn = document.createElement("select");
  private readonly roleArn = input("roleArn");
  /** The role's row, shown while "role" is selected. */
  private readonly roleRow: HTMLElement;
  /**
   * What the role has to trust, shown under its ARN once the engine has said.
   */
  private readonly trust = el("div", "trust");
  private readonly region = document.createElement("div");
  private readonly result = document.createElement("div");
  private readonly saving = document.createElement("div");
  private readonly tryButton = el("button", "");
  private readonly saveButton = el("button", "primary");
  /** The sign-in options the engine last answered with. */
  private offered: SignIns = PUBLIC_ONLY;
  private status: Status = { t: "untried" };
  /**
   * Counts tries, so an answer for fields that have since changed is dropped.
   */
  private tries = 0;
  /**
   * Whether the person chose a sign-in option, so arriving options leave it
   * in place.
   */
  private picked = false;
  /** The connection a save is in progress for. */
  private keeping: Connection | undefined;

  constructor(
    private readonly asks: ConnectAsks,
    /**
     * Called when the form is done: with the saved connection, or undefined on
     * Cancel.
     */
    private readonly done: (saved: Connection | undefined) => void,
    private readonly tells: ConnectTells,
  ) {
    const form = this.el;
    form.className = "panel-connect";
    form.hidden = true;
    form.noValidate = true;
    const words = this.words;
    words.attr(form, "aria-label", m.connect_form_aria);

    const title = words.text(el("div", "title"), m.connect_title);

    words.attr(this.bucket, "aria-label", m.connect_bucket_aria);
    this.bucket.placeholder = EXAMPLE_BUCKET;
    words.attr(this.prefix, "aria-label", m.connect_prefix_aria);
    words.placeholder(this.prefix, m.connect_prefix_placeholder);
    words.text(this.tryButton, m.action_test);
    words.text(this.saveButton, m.connect_save);
    words.attr(this.signIn, "aria-label", m.connect_sign_in_aria);
    this.signIn.addEventListener("change", () => (this.picked = true));
    words.attr(this.roleArn, "aria-label", m.connect_role_aria);
    this.roleArn.placeholder = EXAMPLE_ROLE;
    this.roleRow = field(words, m.field_role, this.roleArn);
    this.region.className = "value";
    this.result.className = "result";
    this.result.setAttribute("role", "status");
    this.saving.className = "fine";

    const cancel = words.text(el("button", ""), m.action_cancel);
    cancel.type = "button";
    cancel.addEventListener("click", () => this.cancel());
    this.tryButton.type = "button";
    this.tryButton.addEventListener("click", () => void this.test());
    const buttons = el("div", "buttons");
    buttons.append(cancel, this.tryButton, this.saveButton);

    form.append(
      title,
      field(words, m.field_bucket, this.bucket),
      field(words, m.field_prefix, this.prefix),
      field(words, m.field_sign_in, this.signIn),
      this.roleRow,
      this.trust,
      field(words, m.field_region, this.region),
      this.result,
      buttons,
      this.saving,
    );

    // Enter in any field and the Save button both submit.
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });
    form.addEventListener("input", () => this.edited());
    form.addEventListener("change", () => this.edited());
    form.addEventListener("keydown", (e) => {
      // Keep the key from reaching the grid and the shell's shortcuts.
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

  /** relabel rewrites the form's text in the current language. */
  relabel(): void {
    this.words.write();
    this.options(this.offered);
    this.paint();
  }

  /**
   * show opens the form with `filled` and asks the engine for its sign-in
   * options.
   */
  show(filled: Filled = {}): void {
    this.bucket.value = filled.bucket ?? "";
    this.prefix.value = filled.prefix ?? "";
    this.roleArn.value = "";
    this.status = { t: "untried" };
    this.tries++;
    this.keeping = undefined;
    this.picked = false;
    this.el.hidden = false;
    this.options(PUBLIC_ONLY);
    this.paint();
    void this.asks.signIns().then(
      (offered) => this.options(offered),
      // When the engine fails to answer, offer public only.
      () => this.options(PUBLIC_ONLY),
    );
    (filled.bucket === undefined ? this.bucket : this.prefix).focus();
  }

  hide(): void {
    this.el.hidden = true;
    this.tries++;
    this.keeping = undefined;
  }

  /**
   * The fields as a connection, or the message saying why they are refused.
   */
  private draft(): Connection | string {
    const c = draftOf(
      {
        bucket: this.bucket.value,
        prefix: this.prefix.value,
        signIn: this.signIn.value as SignIn,
        roleArn: this.roleArn.value,
      },
      this.asks.known(),
    );
    if (c.bucket === "") return m.connect_name_bucket();
    if (c.auth.mode === "role" && c.auth.roleArn === "") return m.connect_name_role();
    try {
      validConnection(c);
    } catch (err) {
      return message(err);
    }
    return c;
  }

  /**
   * test tries the current fields and shows the result. An answer that lands
   * after the fields changed is dropped.
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
   * save tests the fields, reusing a test already made for them, then saves
   * the connection the test returned. A failed test ends in a refusal.
   *
   * The form hides itself while this runs. On refusal it stays hidden, holding
   * the reason, until `reopen`. If the form was reopened or closed meanwhile,
   * the result is dropped.
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
    // The test failed and set the status to refused.
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

  /** refuse ends the save in progress and reports why. */
  private refuse(draft: Connection, why: string): void {
    this.keeping = undefined;
    this.status = { t: "refused", why };
    this.tells.refused(draft, why);
  }

  /** reopen shows the form again as it was left, with the refusal shown. */
  reopen(): void {
    this.el.hidden = false;
    this.paint();
    this.bucket.focus();
  }

  private cancel(): void {
    this.hide();
    this.done(undefined);
  }

  /** A field changed, so the last test is set aside. */
  private edited(): void {
    if (this.status.t === "untried") return this.paint();
    this.tries++;
    this.status = { t: "untried" };
    this.paint();
  }

  /**
   * options fills the sign-in select with the engine's options, in its order.
   */
  private options(offered: SignIns): void {
    this.offered = offered;
    const was = this.signIn.value;
    const choices = offered.modes.flatMap((mode) => CHOICES[mode](offered));
    this.signIn.replaceChildren(...choices.map(([value, label]) => option(label, value)));
    // Keep the person's choice if it is still offered. Otherwise pick the
    // "default" profile if there is one, else the first option.
    const keep =
      this.picked && choices.some(([v]) => v === was)
        ? was
        : offered.profiles.includes("default")
          ? "profile:default"
          : (choices[0]?.[0] ?? "public");
    this.signIn.value = keep;
    // A changed select counts as an edit, which drops the last test. Only
    // while the form is on screen: during a save the draft is already taken.
    if (this.open && this.signIn.value !== was) this.edited();
    else this.paint();
  }

  private paint(): void {
    const s = this.status;
    // The role row shows while "role" is selected. The trust line shows once
    // the engine has said what the role has to trust.
    const role = this.signIn.value === "role";
    this.roleRow.hidden = !role;
    const trust = this.offered.trust;
    this.trust.hidden = !role || trust === undefined;
    this.trust.textContent =
      trust === undefined
        ? ""
        : m.connect_trust({ principal: trust.principal, externalId: trust.externalId });
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

    // The save line: the file the connection will be saved as, and what it
    // holds of the sign-in.
    const draft = this.draft();
    const where =
      typeof draft === "string" ? m.connect_saving_each() : m.connect_saving_as({ id: draft.id });
    const keys = this.offered.modes.includes("role")
      ? m.connect_keys_role()
      : m.connect_keys_profiles();
    this.saving.textContent = `${where} ${keys}`;
  }
}

/**
 * key identifies what a test was of, so save can tell whether the fields
 * changed since.
 */
function key(c: Connection): string {
  return JSON.stringify([c.bucket, c.prefix, c.auth]);
}

/** input creates one text field with `name`. */
function input(name: string): HTMLInputElement {
  const box = el("input");
  box.name = name;
  box.spellcheck = false;
  box.autocomplete = "off";
  return box;
}

/** field is one labelled row of the form. */
function field(words: Words, label: () => string, control: HTMLElement): HTMLElement {
  const row = el("label", "field");
  row.append(words.text(el("span"), label), control);
  return row;
}
