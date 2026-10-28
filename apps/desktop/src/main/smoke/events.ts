/**
 * @fileoverview The JSON Lines file the widen checks open: page events, each
 * with an id, what happened, the page and how long it took, and from late in
 * the file a campaign as well.
 *
 * smoke.js writes it beside a workspace that says it was read as JSON Lines,
 * since a .jsonl file named on its own is not read yet. The checks read the
 * same facts from here.
 */

/** The file's name, and the workspace's that holds it. */
export const EVENTS_FILE = "events.jsonl";
export const EVENTS_WORKSPACE = "events.uno";

/** The keys every event has, in the order the file first holds them. */
export const EVENT_KEYS = ["id", "event", "page", "ms"];

/** The key first seen late in the file. */
export const LATE_KEY = "campaign";

/** How many events the file holds: enough for several of the index's chunks. */
export const EVENTS = 600_000;

/**
 * The first event with LATE_KEY. The index reaches it chunks after the
 * file opens, so its first rows are drawn before the key is known.
 */
export const LATE_EVENT = 560_000;

const NAMES = ["view", "click", "scroll", "signup"];
const PAGES = ["/", "/pricing", "/docs/start", "/blog/q3-report"];
const CAMPAIGNS = ["autumn-sale", "newsletter", "partner-q3"];

/** The fewest milliseconds an event took, and the spread above it. */
const FASTEST_MS = 40;
const SPREAD_MS = 900;
/** A prime that walks the spread without repeating soon. */
const STRIDE_MS = 37;

/** pick returns the entry of `from` that event `n` takes. */
function pick(from: readonly string[], n: number): string {
  return from[n % from.length]!;
}

/** eventLine returns the line event `n` is written as, with no line end. */
export function eventLine(n: number): string {
  const event = {
    id: n + 1,
    event: pick(NAMES, n),
    page: pick(PAGES, Math.floor(n / NAMES.length)),
    ms: FASTEST_MS + ((n * STRIDE_MS) % SPREAD_MS),
  };
  const late = n >= LATE_EVENT ? { [LATE_KEY]: pick(CAMPAIGNS, n) } : {};
  return JSON.stringify({ ...event, ...late });
}

/** eventsText returns the whole file: every event on a line of its own. */
export function eventsText(): string {
  return Array.from({ length: EVENTS }, (_, n) => `${eventLine(n)}\n`).join("");
}
