import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * sha256Hex returns the SHA-256 of `bytes` as lower-case hex. It is
 * synchronous, as `writeDocument` needs; Web Crypto is async.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
