// The keys an object in a bucket turns out to have.
//
// An S3 key is any UTF-8 string up to 1024 bytes, and exports land in buckets
// with spaces, plus signs, per cent signs, accents and empty segments in their
// names. SigV4 signs the path as it goes on the wire, so a key has to be
// encoded once, signed as encoded, and sent unchanged: a signature over one
// path and a request for another is a 403, and a request for a path something
// quietly rewrote is worse than a 403, because it is somebody else's object
// with no error at all.
//
// The stand-in in s3.test.ts and the real bucket in s3.live.test.ts read this
// same list, so a key that works against one is known to work against both.

/**
 * Each key, and what it must look like on the wire: RFC 3986 unreserved
 * characters left alone, everything else %XX, and the slashes between segments
 * kept as slashes.
 */
export const AWKWARD_KEYS: ReadonlyArray<readonly [key: string, encoded: string]> = [
  ["sales q3.csv", "sales%20q3.csv"],
  ["sales+q3.csv", "sales%2Bq3.csv"],
  ["100%.csv", "100%25.csv"],
  // A key whose own name contains what looks like an escape. It is not one.
  ["sales%20q3.csv", "sales%2520q3.csv"],
  ["ventas-ñ/λ-q3.csv", "ventas-%C3%B1/%CE%BB-q3.csv"],
  // An empty segment is part of the name, not a slash to be tidied away.
  ["empty//segment.csv", "empty//segment.csv"],
  ["a=b&c.csv", "a%3Db%26c.csv"],
  // ~ is unreserved and stays. ! ' ( ) * are not, and encodeURIComponent
  // leaves them alone, so uno and S3 would disagree about the signature.
  ["~tilde'quote(1)!.csv", "~tilde%27quote%281%29%21.csv"],
  // A question mark in a key is not the start of a query, and a hash is not
  // the start of a fragment.
  ["q?x=1.csv", "q%3Fx%3D1.csv"],
  ["has#hash.csv", "has%23hash.csv"],
];

/**
 * The keys URL resolves away. `new URL` and fetch both collapse a `.` or `..`
 * segment, and collapse `%2E` and `%2E%2E` with it, so these cannot be asked
 * for by spelling them differently. What must never happen is reading the
 * object the collapsed path lands on and calling it the answer.
 *
 * Each is paired with the key it collapses onto.
 */
export const DOT_KEYS: ReadonlyArray<readonly [key: string, collapsesOnto: string]> = [
  ["2025/quarterly/../sales-q3.csv", "2025/sales-q3.csv"],
  ["2025/./sales-q3.csv", "2025/sales-q3.csv"],
];
