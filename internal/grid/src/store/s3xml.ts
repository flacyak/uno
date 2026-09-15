// A reader for exactly the elements a ListBucketResult uses, and nothing else.
//
// ListObjectsV2 answers in XML, and it is the only XML uno reads. An XML parser
// would be a dependency the size of the engine for one reply whose shape is
// fixed and published, so this reads the six elements that reply is made of and
// ignores everything around them: an element uno has never heard of is an
// element uno does not need, and a bucket that adds one has not broken
// anything.
//
// Nothing here talks to a bucket. It is handed the text of a reply and returns
// what was in it, so every case below -- a truncated page, an ETag with its
// quotes escaped, a key with an ampersand in its name -- is a string in a test
// rather than a server to stand up.

/** One key a page of a listing found, as the XML said it. */
export interface KeyEntry {
  key: string;
  bytes?: number;
  modified?: Date;
  /** The ETag with its quotes, which is the form If-Match wants it back in. */
  version?: string;
}

/** One ListBucketResult, read. */
export interface ListResult {
  /** The keys directly under the prefix that was asked for. */
  keys: KeyEntry[];
  /** What `delimiter=/` folded the keys deeper than that into: the folders. */
  prefixes: string[];
  /** Whether the bucket says this prefix has more pages after this one. */
  truncated: boolean;
  /** The token the next page is asked for with, when the bucket gave one. */
  next?: string;
}

/**
 * readListing reads one ListBucketResult.
 *
 * `Contents` and `CommonPrefixes` are read out of their own elements rather than
 * by name, because `Prefix` appears twice in a reply: once inside each
 * CommonPrefixes, and once at the top where the bucket echoes back what was
 * asked for. Reading the document for every `Prefix` would put the folder
 * somebody is standing in into the list of folders inside it.
 *
 * What it cannot do is a key holding a character XML cannot carry -- a
 * backspace, a carriage return -- which S3 sends raw and no parser can recover.
 * `encoding-type=url` is the answer to that when a real bucket proves it is
 * needed; it is not sent yet, because it changes how keys, and only some of the
 * other elements, come back, and no bucket has confirmed which.
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
 * keyIn is one Contents as a key, or nothing where it holds no Key at all.
 *
 * Nothing is a list of none rather than an absence, so the caller's own
 * classifying stays one flatMap. A Contents with no Key is not a key with an
 * empty name, it is a reply uno cannot use, and the size of it is no use
 * either.
 *
 * `bytes` and `modified` are each dropped on their own where they cannot be
 * read, because half a Contents is still a key somebody can open, and the panel
 * already draws a dash where it was given no size.
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

/** The date a LastModified names, or nothing where it names none. */
function when(stamp: string | undefined): Date | undefined {
  if (stamp === undefined) return undefined;
  const at = new Date(stamp.trim());
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Every `<name>…</name>` in the reply, as it came: the escaping is left alone
 * here, because what is between the tags of a Contents is more elements and
 * undoing their escaping before they have been read would be reading a `&lt;`
 * inside a key's name as the start of one.
 */
function blocks(xml: string, name: string): string[] {
  const found: string[] = [];
  for (const m of xml.matchAll(element(name, "g"))) found.push(m[1]!);
  return found;
}

/**
 * element matches one `<name>…</name>`, whatever attributes the tag carries:
 * AWS puts an xmlns on the root and none on anything inside it, and an
 * S3-compatible store is free to put one anywhere.
 */
function element(name: string, flags = ""): RegExp {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, flags);
}

/**
 * text is the first `<name>…</name>` in the reply, decoded.
 *
 * Undefined where the element is not there at all, which is a different answer
 * from the empty string: a reply with no NextContinuationToken is the last page,
 * and one with an empty one is a bucket uno cannot page.
 */
function text(xml: string, name: string): string | undefined {
  const one = element(name).exec(xml);
  return one === null ? undefined : entities(one[1]!);
}

/**
 * entities undoes the escaping XML does: the five it defines, and the numeric
 * form.
 *
 * It is not decoration. A key is any UTF-8 string, so `a&b.csv` comes back as
 * `a&amp;b.csv`, and an ETag comes back with its quotes as `&quot;` -- and the
 * quotes are part of the ETag, which If-Match is compared against byte for
 * byte. A reader that left them escaped would hand back keys nothing could open
 * and versions nothing would match.
 */
export function entities(s: string): string {
  return s.replace(/&(#[0-9]+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const named = NAMED[code.toLowerCase()];
    if (named !== undefined) return named;
    const point =
      code.startsWith("#x") || code.startsWith("#X")
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
    // A code point outside what a string can hold is not an escape uno can
    // undo, and leaving it as it came is closer to the truth than a question
    // mark would be.
    return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : whole;
  });
}

/** The five entities XML defines. An XML document has no others. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
