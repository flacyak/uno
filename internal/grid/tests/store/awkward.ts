// Object keys with characters that need care on the wire.
//
// Each key is paired with how it must appear in a signed request path. The
// stand-in in s3.test.ts and the real bucket in s3.live.test.ts both read
// this list.

/**
 * Each key and its encoded form on the wire: RFC 3986 unreserved characters
 * left alone, everything else %XX, and the slashes between segments kept.
 */
export const AWKWARD_KEYS: ReadonlyArray<readonly [key: string, encoded: string]> = [
  ["sales q3.csv", "sales%20q3.csv"],
  ["sales+q3.csv", "sales%2Bq3.csv"],
  ["100%.csv", "100%25.csv"],
  // The key itself contains a %20, which is encoded again.
  ["sales%20q3.csv", "sales%2520q3.csv"],
  ["ventas-ñ/λ-q3.csv", "ventas-%C3%B1/%CE%BB-q3.csv"],
  // An empty segment stays in the path.
  ["empty//segment.csv", "empty//segment.csv"],
  ["a=b&c.csv", "a%3Db%26c.csv"],
  // ~ is unreserved and stays. ! ' ( ) * are encoded, which goes further
  // than encodeURIComponent.
  ["~tilde'quote(1)!.csv", "~tilde%27quote%281%29%21.csv"],
  // ? and # in a key are encoded, so they stay part of the path.
  ["q?x=1.csv", "q%3Fx%3D1.csv"],
  ["has#hash.csv", "has%23hash.csv"],
];

/**
 * Keys with a `.` or `..` segment. `new URL` and fetch collapse those
 * segments, and the `%2E` forms with them, so a request for one of these keys
 * lands on another key. Each is paired with the key the collapsed path lands
 * on. The handler refuses these keys outright.
 */
export const DOT_KEYS: ReadonlyArray<readonly [key: string, collapsesOnto: string]> = [
  ["2025/quarterly/../sales-q3.csv", "2025/sales-q3.csv"],
  ["2025/./sales-q3.csv", "2025/sales-q3.csv"],
];
