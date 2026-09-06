import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * sha256Hex is what a .uno manifest records about the bytes it carries.
 *
 * It is synchronous, which is the reason for the dependency: Web Crypto is
 * async, and awaiting it would make `writeDocument` async for a reason no
 * caller can see.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
