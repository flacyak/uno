// A reader for the elements of a ListBucketResult, also used for the STS
// reply.
//
// It reads the few elements it needs with regular expressions and ignores
// the rest. It works on the text of a reply it is handed.

/** One key from a page of a listing. */
export interface KeyEntry {
  key: string;
  bytes?: number;
  modified?: Date;
  /** The ETag with its quotes, which is the form If-Match takes. */
  version?: string;
}

/** One ListBucketResult, read. */
export interface ListResult {
  /** The keys directly under the prefix asked for. */
  keys: KeyEntry[];
  /** The common prefixes `delimiter=/` folded deeper keys into: the folders. */
  prefixes: string[];
  /** Whether S3 says there are more pages. */
  truncated: boolean;
  /** The continuation token for the next page, when S3 gave one. */
  next?: string;
}

/**
 * readListing reads one ListBucketResult.
 *
 * `Contents` and `CommonPrefixes` blocks are found first and their children
 * read inside each block, since `Prefix` also appears at the top level, where
 * S3 echoes the prefix asked for.
 *
 * The listing is requested plain, with `encoding-type=url` left out, so a
 * key is read as it comes. A key holding a character outside XML's set is
 * out of scope.
 */
export function readListing(xml: string): ListResult {
  const next = text(xml, "NextContinuationToken");
  return {
    keys: blocks(xml, "Contents").flatMap(keyIn),
    prefixes: blocks(xml, "CommonPrefixes").flatMap((block) => {
      const prefix = text(block, "Prefix");
      return prefix === undefined || prefix === "" ? [] : [prefix];
    }),
    truncated: text(xml, "IsTruncated")?.trim().toLowerCase() === "true",
    ...(next === undefined || next === "" ? {} : { next }),
  };
}

/**
 * keyIn reads one Contents block as a KeyEntry, or none for a block missing
 * its Key.
 * `bytes`, `modified` and `version` are each set only where readable.
 */
function keyIn(block: string): KeyEntry[] {
  const key = text(block, "Key");
  if (key === undefined || key === "") return [];

  const bytes = Number(text(block, "Size") ?? "NaN");
  const modified = when(text(block, "LastModified"));
  const version = text(block, "ETag");
  return [
    {
      key,
      ...(Number.isFinite(bytes) ? { bytes } : {}),
      ...(modified === undefined ? {} : { modified }),
      ...(version === undefined || version === "" ? {} : { version }),
    },
  ];
}

/**
 * when parses a LastModified element or a Last-Modified header as a Date.
 * Undefined for a missing or unreadable stamp.
 */
export function when(stamp: string | null | undefined): Date | undefined {
  if (stamp === undefined || stamp === null) return undefined;
  const at = new Date(stamp.trim());
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * blocks returns the raw text inside every `<name>…</name>`. Entities are
 * left as they are, since the text holds more elements still to be read.
 */
function blocks(xml: string, name: string): string[] {
  const found: string[] = [];
  for (const m of xml.matchAll(element(name, "g"))) found.push(m[1]!);
  return found;
}

/**
 * element matches one `<name>…</name>`, with any attributes on the opening
 * tag.
 */
function element(name: string, flags = ""): RegExp {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, flags);
}

/**
 * text is the content of the first `<name>…</name>`, with entities decoded.
 * Undefined for a missing element, which is distinct from an empty one.
 */
export function text(xml: string, name: string): string | undefined {
  const one = element(name).exec(xml);
  return one === null ? undefined : entities(one[1]!);
}

/**
 * entities decodes the five named XML entities and numeric character
 * references. A key like `a&b.csv` comes back as `a&amp;b.csv`, and an
 * ETag's quotes come back as `&quot;`.
 */
export function entities(s: string): string {
  return s.replace(/&(#[0-9]+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const named = NAMED[code.toLowerCase()];
    if (named !== undefined) return named;
    const point =
      code.startsWith("#x") || code.startsWith("#X")
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
    // A code point outside the Unicode range is left as it came.
    return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : whole;
  });
}

/** The five named entities XML defines. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
